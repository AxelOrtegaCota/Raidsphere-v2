/**
 * Module C: One process-local scheduler for all translation service entry points.
 * Provider permits survive caller cancellation, disposal, and logical resumption.
 * Module D owns authorization, durable moderation, and final publication checks.
 */
import { z } from 'zod';
import { identifierSchema, languageCodeSchema, timestampSchema, translationBubbleSchema } from '@raidsphere/shared';
import type { LanguageCode, TranslationBubble, ChatFragment } from '@raidsphere/shared';
import { translationRequestSchema, translationResponseSchema, needsTranslation } from './provider.js';
import type { TranslationProvider, TranslationRequest, TranslationResult } from './provider.js';
import { getTranslationProvider } from './mock-provider.js';

export const TRANSLATION_LIMITS = Object.freeze({
  providerOperations: 5, queuedJobs: 100, queueTimeoutMs: 5000, providerTimeoutMs: 10000,
  cacheEntries: 500, cacheTtlMs: 300000, batchSize: 100, activeSessions: 100,
});

export interface TranslateMessageOptions {
  channelId: string;
  receivedAtMs: number;
  messageId: string;
  userId: string;
  displayName: string;
  text: string;
  sourceLanguage: LanguageCode | null;
  targetLanguage: LanguageCode;
  channelEmotes?: string[] | undefined;
    fragments?: ChatFragment[] | undefined;
      simulationMode?: boolean | undefined;
}

/** Opaque at runtime: copying these fields does not create a valid session handle. */
export interface TranslationSession {
  readonly channelId: string;
  readonly sessionId: string;
}

export interface TranslationExecutionOptions {
  signal?: AbortSignal;
  session?: TranslationSession;
}

const optionsSchema = z.object({
  channelId: identifierSchema, receivedAtMs: timestampSchema,
  messageId: identifierSchema, userId: identifierSchema,
  displayName: z.string().min(1).max(100),
  text: translationRequestSchema.shape.text,
  sourceLanguage: languageCodeSchema.nullable(), targetLanguage: languageCodeSchema,
  channelEmotes: translationRequestSchema.shape.channelEmotes,
  fragments: translationRequestSchema.shape.fragments,
  simulationMode: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.fragments && value.fragments.map(fragment => fragment.text).join('') !== value.text) {
    context.addIssue({ code: 'custom', path: ['fragments'], message: 'Fragments must reconstruct the original message.' });
  }
});

type Input = z.infer<typeof optionsSchema>;
type UnavailableReason = Extract<TranslationBubble, { status: 'unavailable' }>['reason'];
interface SessionRecord { readonly handle: TranslationSession; active: boolean }
const sessionRecords = new WeakMap<object, SessionRecord>();
const activeSessions = new Map<string, SessionRecord>();
const executionSchema = z.object({
  signal: z.instanceof(AbortSignal).optional(),
  session: z.custom<TranslationSession>(value =>
    typeof value === 'object' && value !== null && sessionRecords.has(value)
  ).optional(),
}).strict();

export interface TranslationMetrics {
  totalRequests: number;
  cacheHits: number;
  successCount: number;
  errorCount: number;
  averageLatencyMs: number;
}

interface Job {
  readonly input: Input;
  readonly provider: TranslationProvider;
  readonly signal: AbortSignal | undefined;
  readonly session: SessionRecord | undefined;
  readonly cacheGeneration: symbol;
  readonly controller: AbortController;
  readonly resolve: (bubble: TranslationBubble | null) => void;
  phase: 'queued' | 'running' | 'settled';
  invalidated: boolean;
  callerSettled: boolean;
  callerReturned: boolean;
  permitHeld: boolean;
  providerPending: boolean;
  startedAt: number | undefined;
  queueTimer: ReturnType<typeof setTimeout> | undefined;
  providerTimer: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
  providerName: string;
  provenance: 'simulated' | 'provider';
  cacheKey: string;
  cacheResult: TranslationResult | undefined;
}
interface CacheEntry {
  readonly provider: TranslationProvider;
  readonly channelId: string;
  readonly session: SessionRecord | undefined;
  readonly key: string;
  readonly result: Readonly<TranslationResult>;
  readonly expiresAt: number;
}

// This owner is never replaced or reset. Detached provider invocations remain in
// jobs and continue holding permits, even across dispose/resume.
const jobs = new Set<Job>();
const queue: Job[] = [];
const cache = new Map<symbol, CacheEntry>();
let cacheGeneration = Symbol('translation-cache');
let occupiedSlots = 0;
let draining = false;
let disposed = false;
let disposing = false;
let metrics: TranslationMetrics = emptyMetrics();
let latencySamples = 0;

export function translateMessage(
  options: TranslateMessageOptions, provider?: TranslationProvider, execution: TranslationExecutionOptions = {}
): Promise<TranslationBubble | null> {
  return translateTracked(options, provider, execution);
}

async function translateTracked(
  options: TranslateMessageOptions, provider: TranslationProvider | undefined,
  execution: TranslationExecutionOptions, retainForBatch?: (job: Job) => void
): Promise<TranslationBubble | null> {
  const input = parseInput(options);
  const parsedExecution = executionSchema.safeParse(execution);
  if (!parsedExecution.success) throw new TypeError('Invalid translation execution context.');
  const control = parsedExecution.data;
  const session = control.session ? sessionRecords.get(control.session) : undefined;
  if (session && session.handle.channelId !== input.channelId) {
    throw new TypeError('Translation session does not match the message channel.');
  }
  metrics.totalRequests++;
  if (!contextEligible(input.channelId, session, control.signal)) return null;
  if (input.sourceLanguage === null && !retainForBatch) {
    metrics.errorCount++;
    return unavailable(input, 'unsupported_language');
  }
  if (input.sourceLanguage !== null && !needsTranslation(input.sourceLanguage, input.targetLanguage)) return null;

  // Bound queued input and completion records as well as unresolved providers.
  // A batch must not retain message content in an untracked capacity response.
  if (jobs.size >= TRANSLATION_LIMITS.queuedJobs + TRANSLATION_LIMITS.providerOperations) {
    metrics.errorCount++;
    return retainForBatch ? null : unavailable(input, 'capacity');
  }
  const queueAtCapacity = queue.length >= TRANSLATION_LIMITS.queuedJobs;
  if (queueAtCapacity && !retainForBatch) {
    metrics.errorCount++;
    return unavailable(input, 'capacity');
  }

  let resolve: (bubble: TranslationBubble | null) => void = () => {};
  const result = new Promise<TranslationBubble | null>(done => { resolve = done; });
  const job: Job = {
    input, provider: provider ?? getTranslationProvider(), signal: control.signal, session,
    cacheGeneration, controller: new AbortController(), resolve,
    phase: 'queued', invalidated: false, callerSettled: false, callerReturned: false,
    permitHeld: false, providerPending: false, startedAt: undefined,
    queueTimer: undefined, providerTimer: undefined, abortListener: undefined,
    providerName: '', provenance: 'provider', cacheKey: '', cacheResult: undefined,
  };
  jobs.add(job);
  retainForBatch?.(job);
  if (input.sourceLanguage === null) {
    finish(job, unavailable(input, 'unsupported_language'));
  } else if (queueAtCapacity) {
    // Queue capacity and delivery-record capacity are independent bounds.
    finish(job, unavailable(input, 'capacity'));
  } else {
    queue.push(job);
    job.queueTimer = setTimeout(() => {
      finish(job, eligible(job) ? unavailable(input, 'timeout') : null, true);
    }, TRANSLATION_LIMITS.queueTimeoutMs);
    if (job.signal) {
      job.abortListener = () => { finish(job, null, true); };
      job.signal.addEventListener('abort', job.abortListener, { once: true });
      if (job.signal.aborted) finish(job, null, true);
    }
    drain();
  }

  try {
    const bubble = await result;
    // A batch owns delivery beyond individual settlement. Its existing job record
    // stays in the bounded tracking set, including on cache hits and timeouts.
    return retainForBatch ? bubble : deliveryResult(job, bubble);
  } finally {
    if (!retainForBatch) {
      job.callerReturned = true;
      releaseRecord(job);
    }
  }
}

export async function translateMessages(
  messages: TranslateMessageOptions[], provider?: TranslationProvider, execution: TranslationExecutionOptions = {}
): Promise<(TranslationBubble | null)[]> {
  if (!Array.isArray(messages) || messages.length > TRANSLATION_LIMITS.batchSize) {
    throw new TypeError('A translation batch must contain at most 100 messages.');
  }
  // Validate the entire bounded batch before dispatching any accepted elements.
  const inputs = messages.map(parseInput);
  const control = executionSchema.safeParse(execution);
  if (!control.success) throw new TypeError('Invalid translation execution context.');
  if (control.data.session && inputs.some(input => input.channelId !== control.data.session?.channelId)) {
    throw new TypeError('Translation session does not match the batch channels.');
  }
  const deliveries: (Job | undefined)[] = new Array(inputs.length);
  let delivered = false;
  try {
    const results = await Promise.all(inputs.map((input, index) =>
      translateTracked(input, provider, control.data, job => { deliveries[index] = job; })
    ));
    // No asynchronous boundary separates eligibility checks from batch return.
    // Every non-null batch outcome requires a retained delivery record. Fail
    // closed even if a future early-return path forgets to register ownership.
    const output = results.map((bubble, index) => {
      const job = deliveries[index];
      return job ? deliveryResult(job, bubble) : null;
    });
    delivered = true;
    return output;
  } finally {
    // If collection fails, invalidate all owned records before abort callbacks can
    // reenter. Physical permits remain owned until their provider promises settle.
    if (!delivered) {
      for (const job of deliveries) if (job) job.invalidated = true;
      for (const job of deliveries) if (job) finish(job, null);
      for (const job of deliveries) if (job) job.controller.abort();
    }
    for (const job of deliveries) {
      if (!job) continue;
      job.callerReturned = true;
      releaseRecord(job);
    }
  }
}

function deliveryResult(job: Job, bubble: TranslationBubble | null): TranslationBubble | null {
  if (!eligible(job)) return null;
  if (bubble?.status === 'completed' && job.cacheResult && job.cacheGeneration === cacheGeneration) {
    storeCache(job, job.cacheResult);
  }
  return bubble;
}

function parseInput(options: TranslateMessageOptions): Input {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new TypeError('Invalid translation message options.');
  return parsed.data;
}

function contextEligible(channelId: string, session: SessionRecord | undefined, signal?: AbortSignal): boolean {
  if (disposed || signal?.aborted) return false;
  const current = activeSessions.get(channelId);
  // Once a channel has an active session, unscoped submissions cannot implicitly
  // attach to it. Previously issued session handles never become active again.
  return session ? session.active && current === session : current === undefined;
}

function eligible(job: Job): boolean {
  return !job.invalidated && contextEligible(job.input.channelId, job.session, job.signal);
}

function drain(): void {
  if (draining || disposed) return;
  draining = true;
  try {
    while (!disposed && occupiedSlots < TRANSLATION_LIMITS.providerOperations && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.callerSettled) continue;
      if (!eligible(job)) { finish(job, null, true); continue; }
      start(job);
    }
  } finally {
    draining = false;
  }
}

function start(job: Job): void {
  job.phase = 'running';
  job.permitHeld = true;
  occupiedSlots++;
  if (job.queueTimer !== undefined) clearTimeout(job.queueTimer);
  job.queueTimer = undefined;
  try {
    // Metadata access and capability callbacks are provider-controlled boundaries.
    job.providerName = job.provider.name;
    job.provenance = job.provider.provenance;
    if (!z.string().min(1).max(128).safeParse(job.providerName).success ||
        (job.provenance !== 'provider' && job.provenance !== 'simulated')) {
      finish(job, unavailable(job.input, 'provider_error')); return;
    }
    if (!eligible(job) || job.callerSettled) { finish(job, null, true); return; }
    if (job.provenance === 'simulated' && job.input.simulationMode !== true) {
      finish(job, unavailable(job.input, 'provider_error')); return;
    }
    const source = job.input.sourceLanguage;
    if (source === null) { finish(job, unavailable(job.input, 'unsupported_language')); return; }
    const supported = job.provider.supportsLanguagePair(source, job.input.targetLanguage);
    if (!eligible(job) || job.callerSettled) { finish(job, null, true); return; }
    if (supported !== true) { finish(job, unavailable(job.input, 'unsupported_language')); return; }

    job.cacheKey = JSON.stringify([
      job.input.channelId, job.providerName, job.provenance, source, job.input.targetLanguage,
      job.input.text, job.input.channelEmotes ?? [], job.input.fragments ?? null, job.input.simulationMode === true,
    ]);
    const cached = lookupCache(job);
    if (cached) {
      finish(job, completed(job.input, cached), false, true); return;
    }
    const request: TranslationRequest = {
      text: job.input.text, sourceLanguage: source, targetLanguage: job.input.targetLanguage,
      channelEmotes: [...(job.input.channelEmotes ?? [])],
      ...(job.input.fragments === undefined ? {} : { fragments: job.input.fragments.map(fragment => ({ ...fragment })) }),
      simulationMode: job.input.simulationMode === true,
    };
    if (!eligible(job) || job.callerSettled) { finish(job, null, true); return; }
    job.startedAt = performance.now();
    job.providerTimer = setTimeout(() => {
      finish(job, eligible(job) ? unavailable(job.input, 'timeout') : null, true);
    }, TRANSLATION_LIMITS.providerTimeoutMs);

    const pending = Promise.resolve(job.provider.translate(request, { signal: job.controller.signal }));
    job.providerPending = true;
    // Both handlers are attached immediately. Caller settlement never releases
    // this permit; only the provider settlement handler does.
    void pending.then(
      response => providerSettled(job, response, false),
      () => providerSettled(job, undefined, true)
    );
  } catch {
    finish(job, eligible(job) ? unavailable(job.input, 'provider_error') : null);
  } finally {
    // Includes cache hits, invalid metadata, and synchronous provider throws.
    if (!job.providerPending) releasePermit(job);
  }
}

function providerSettled(job: Job, response: unknown, failed: boolean): void {
  try {
    if (job.callerSettled) return;
    if (!eligible(job)) { finish(job, null, true); return; }
    if (failed) { finish(job, unavailable(job.input, 'provider_error')); return; }
    const parsed = translationResponseSchema.safeParse(response);
    if (!eligible(job) || job.callerSettled) { finish(job, null, true); return; }
    if (!parsed.success) { finish(job, unavailable(job.input, 'provider_error')); return; }
    if (!parsed.data.success) {
      const code = parsed.data.error.code;
      finish(job, unavailable(job.input, code === 'INVALID_LANGUAGE' ? 'unsupported_language'
        : code === 'TIMEOUT' ? 'timeout' : code === 'RATE_LIMIT' ? 'capacity' : 'provider_error'));
      return;
    }
    const result = parsed.data.result;
    if (result.originalText !== job.input.text || result.sourceLanguage !== job.input.sourceLanguage ||
        result.targetLanguage !== job.input.targetLanguage || result.provider !== job.providerName ||
        result.provenance !== job.provenance) {
      finish(job, unavailable(job.input, 'provider_error')); return;
    }
    job.cacheResult = result;
    finish(job, completed(job.input, result));
  } catch {
    finish(job, eligible(job) ? unavailable(job.input, 'provider_error') : null);
  } finally {
    job.providerPending = false;
    releasePermit(job);
  }
}

function finish(job: Job, bubble: TranslationBubble | null, abort = false, cacheHit = false): void {
  if (job.callerSettled) return;
  job.callerSettled = true;
  if (!eligible(job)) bubble = null;
  if (bubble === null) job.invalidated = true;
  if (job.queueTimer !== undefined) clearTimeout(job.queueTimer);
  if (job.providerTimer !== undefined) clearTimeout(job.providerTimer);
  job.queueTimer = undefined;
  job.providerTimer = undefined;
  if (job.abortListener) job.signal?.removeEventListener('abort', job.abortListener);
  job.abortListener = undefined;
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  if (bubble?.status === 'completed') {
    if (cacheHit) metrics.cacheHits++;
    else metrics.successCount++;
  } else if (bubble?.status === 'unavailable') {
    metrics.errorCount++;
  }
  if (job.startedAt !== undefined) {
    const elapsed = Math.max(0, performance.now() - job.startedAt);
    metrics.averageLatencyMs = (metrics.averageLatencyMs * latencySamples + elapsed) / (latencySamples + 1);
    latencySamples++;
  }
  job.resolve(bubble);
  if (abort) job.controller.abort();
  releaseRecord(job);
  drain();
}

function releasePermit(job: Job): void {
  if (!job.permitHeld) return;
  job.permitHeld = false;
  job.phase = 'settled';
  occupiedSlots--;
  releaseRecord(job);
  drain();
}

function releaseRecord(job: Job): void {
  if (job.callerReturned && !job.permitHeld && !job.providerPending) jobs.delete(job);
}

function completed(input: Input, result: Readonly<TranslationResult>): TranslationBubble {
  return translationBubbleSchema.parse({
    status: 'completed', messageId: input.messageId, userId: input.userId, displayName: input.displayName,
    original: input.text, fragments: input.fragments ?? [{ type: 'text', text: input.text }],
    fromLanguage: result.sourceLanguage, toLanguage: input.targetLanguage,
    illustrativeCountry: null, receivedAtMs: input.receivedAtMs, translated: result.translatedText,
  });
}

function unavailable(input: Input, reason: UnavailableReason): TranslationBubble {
  return translationBubbleSchema.parse({
    status: 'unavailable', messageId: input.messageId, userId: input.userId, displayName: input.displayName,
    original: input.text, fragments: input.fragments ?? [{ type: 'text', text: input.text }],
    fromLanguage: input.sourceLanguage, toLanguage: input.targetLanguage,
    illustrativeCountry: null, receivedAtMs: input.receivedAtMs, translated: null, reason,
  });
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now || (entry.session && !entry.session.active)) cache.delete(key);
  }
}

function lookupCache(job: Job): Readonly<TranslationResult> | undefined {
  pruneCache();
  if (!eligible(job)) return undefined;
  for (const [key, entry] of cache) {
    if (entry.provider === job.provider && entry.session === job.session && entry.key === job.cacheKey) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.result;
    }
  }
  return undefined;
}

function storeCache(job: Job, result: TranslationResult): void {
  if (!eligible(job) || job.cacheGeneration !== cacheGeneration) return;
  pruneCache();
  for (const [key, entry] of cache) {
    if (entry.provider === job.provider && entry.session === job.session && entry.key === job.cacheKey) cache.delete(key);
  }
  cache.set(Symbol('entry'), {
    provider: job.provider, channelId: job.input.channelId, session: job.session,
    key: job.cacheKey, result: Object.freeze({ ...result }), expiresAt: Date.now() + TRANSLATION_LIMITS.cacheTtlMs,
  });
  while (cache.size > TRANSLATION_LIMITS.cacheEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Clearing content does not cancel callers or release provider capacity. */
export function clearTranslationCache(): void {
  cacheGeneration = Symbol('translation-cache');
  cache.clear();
}

function invalidate(
  channelId: string, matchesJob: (job: Job) => boolean,
  matchesCache: (entry: CacheEntry) => boolean = entry => entry.channelId === channelId
): number {
  cacheGeneration = Symbol('translation-cache');
  for (const [key, entry] of cache) if (matchesCache(entry)) cache.delete(key);
  const affected = [...jobs].filter(job => job.input.channelId === channelId && matchesJob(job) && !job.callerReturned);
  // Mark every target before invoking abort listeners, which can reenter service APIs.
  for (const job of affected) job.invalidated = true;
  const newlySettled = affected.filter(job => !job.callerSettled);
  for (const job of newlySettled) finish(job, null);
  for (const job of affected) job.controller.abort();
  drain();
  return newlySettled.length;
}

export function invalidateTranslationMessage(channelId: string, messageId: string): number {
  validateIdentifiers(channelId, messageId);
  return invalidate(channelId, job => job.input.messageId === messageId);
}

export function invalidateTranslationUser(channelId: string, userId: string): number {
  validateIdentifiers(channelId, userId);
  return invalidate(channelId, job => job.input.userId === userId);
}

export function invalidateTranslationChannel(channelId: string): number {
  validateIdentifiers(channelId);
  const session = activeSessions.get(channelId);
  if (session) session.active = false;
  activeSessions.delete(channelId);
  return invalidate(channelId, () => true);
}

export function invalidateTranslationSession(channelId: string, sessionId: string): number {
  validateIdentifiers(channelId, sessionId);
  const session = activeSessions.get(channelId);
  if (session?.handle.sessionId === sessionId) {
    session.active = false;
    activeSessions.delete(channelId);
  }
  return invalidate(channelId, job => job.session?.handle.sessionId === sessionId,
    entry => entry.channelId === channelId && entry.session?.handle.sessionId === sessionId);
}

/**
 * Explicit activation is a coordinator action, not authorization. A new handle
 * revokes the previous handle, even for the same textual session ID. Module D
 * must reject replayed activations and retain durable moderation state.
 */
export function activateTranslationSession(channelId: string, sessionId: string): TranslationSession {
  validateIdentifiers(channelId, sessionId);
  if (disposed) throw new Error('The translation service has been disposed.');
  if (!activeSessions.has(channelId) && activeSessions.size >= TRANSLATION_LIMITS.activeSessions) {
    throw new RangeError('Translation session capacity reached.');
  }
  const previous = activeSessions.get(channelId);
  if (previous) previous.active = false;
  const handle: TranslationSession = Object.freeze({ channelId, sessionId });
  const record: SessionRecord = { handle, active: true };
  sessionRecords.set(handle, record);
  activeSessions.set(channelId, record);
  invalidate(channelId, () => true);
  return handle;
}

export function isTranslationSessionActive(session: TranslationSession): boolean {
  const record = sessionRecords.get(session);
  return !disposed && record !== undefined && record.active && activeSessions.get(record.handle.channelId) === record;
}

function validateIdentifiers(...values: string[]): void {
  if (values.some(value => !identifierSchema.safeParse(value).success)) {
    throw new TypeError('Invalid translation lifecycle identifier.');
  }
}

export function disposeTranslationService(): void {
  if (disposing || disposed) return;
  disposing = true;
  disposed = true;
  try {
    clearTranslationCache();
    for (const session of activeSessions.values()) session.active = false;
    activeSessions.clear();
    const affected = [...jobs];
    for (const job of affected) job.invalidated = true;
    for (const job of affected) finish(job, null);
    for (const job of affected) job.controller.abort();
  } finally {
    disposing = false;
  }
}

/** Resume this same owner; unresolved operations retain every occupied permit. */
export function resumeTranslationService(): boolean {
  if (disposing) return false;
  disposed = false;
  drain();
  return true;
}

export function getTranslationSchedulerState() {
  pruneCache();
  return Object.freeze({
    occupiedSlots,
    unresolvedProviderOperations: [...jobs].filter(job => job.providerPending).length,
    detachedOperations: [...jobs].filter(job => job.providerPending && job.callerSettled).length,
    queuedJobs: queue.length, retainedJobs: jobs.size,
    cacheEntries: cache.size, activeSessions: activeSessions.size, disposed,
  });
}

function emptyMetrics(): TranslationMetrics {
  return { totalRequests: 0, cacheHits: 0, successCount: 0, errorCount: 0, averageLatencyMs: 0 };
}

export function getTranslationMetrics(): TranslationMetrics { return { ...metrics }; }

export function resetTranslationMetrics(): void {
  metrics = emptyMetrics();
  latencySamples = 0;
}
