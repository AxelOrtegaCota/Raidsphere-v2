/**
 * Module C: Standalone translation processing with validated, channel-scoped cache results.
 * Channel identifiers are context, never proof of authentication or publication eligibility.
 */
import { z } from 'zod';
import { identifierSchema, languageCodeSchema, timestampSchema, translationBubbleSchema } from '@raidsphere/shared';
import type { LanguageCode, TranslationBubble, ChatFragment } from '@raidsphere/shared';
import {
  translationRequestSchema, translationResponseSchema, needsTranslation,
} from './provider.js';
import type { TranslationProvider, TranslationRequest, TranslationResult } from './provider.js';
import { getTranslationProvider } from './mock-provider.js';

export interface TranslateMessageOptions {
  channelId: string;
  receivedAtMs: number;
  messageId: string;
  userId: string;
  displayName: string;
  text: string;
  sourceLanguage: LanguageCode | null;
  targetLanguage: LanguageCode;
  channelEmotes?: string[];
  fragments?: ChatFragment[];
  simulationMode?: boolean;
}

const translateMessageOptionsSchema = z.object({
  channelId: identifierSchema,
  receivedAtMs: timestampSchema,
  messageId: identifierSchema,
  userId: identifierSchema,
  displayName: z.string().min(1).max(100),
  text: translationRequestSchema.shape.text,
  sourceLanguage: languageCodeSchema.nullable(),
  targetLanguage: languageCodeSchema,
  channelEmotes: translationRequestSchema.shape.channelEmotes,
  fragments: translationRequestSchema.shape.fragments,
  simulationMode: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.fragments && value.fragments.map(fragment => fragment.text).join('') !== value.text) {
    context.addIssue({ code: 'custom', path: ['fragments'], message: 'Fragments must reconstruct the original message.' });
  }
});

type ValidatedMessageOptions = z.infer<typeof translateMessageOptionsSchema>;
type UnavailableReason = Extract<TranslationBubble, { status: 'unavailable' }>['reason'];

export interface TranslationMetrics {
  totalRequests: number;
  cacheHits: number;
  successCount: number;
  errorCount: number;
  averageLatencyMs: number;
}

// Provider instances are separate namespaces even when their names match.
// Capacity, job cancellation, and timer disposal remain Batch 3 work.
let translationCaches = new WeakMap<TranslationProvider, Map<string, TranslationResult>>();
const CACHE_TTL_MS = 5 * 60 * 1000;
let metrics: TranslationMetrics = {
  totalRequests: 0, cacheHits: 0, successCount: 0, errorCount: 0, averageLatencyMs: 0,
};
let latencySamples = 0;

export async function translateMessage(
  options: TranslateMessageOptions,
  provider?: TranslationProvider
): Promise<TranslationBubble | null> {
  const parsed = translateMessageOptionsSchema.safeParse(options);
  if (!parsed.success) throw new TypeError('Invalid translation message options.');
  // Parsing snapshots arrays and fragments before an asynchronous provider can run.
  const input = parsed.data;
  metrics.totalRequests++;

  if (input.sourceLanguage === null) return unavailable(input, 'unsupported_language');
  if (!needsTranslation(input.sourceLanguage, input.targetLanguage)) return null;

  const translationProvider = provider ?? getTranslationProvider();
  const providerName = translationProvider.name;
  const provenance = translationProvider.provenance;
  if (!z.string().min(1).max(128).safeParse(providerName).success ||
      (provenance !== 'provider' && provenance !== 'simulated')) {
    return unavailable(input, 'provider_error');
  }
  if (provenance === 'simulated' && input.simulationMode !== true) {
    return unavailable(input, 'provider_error');
  }
  try {
    if (!translationProvider.supportsLanguagePair(input.sourceLanguage, input.targetLanguage)) {
      return unavailable(input, 'unsupported_language');
    }
  } catch {
    return unavailable(input, 'provider_error');
  }

  const cacheKey = JSON.stringify([
    input.channelId, providerName, provenance, input.sourceLanguage, input.targetLanguage,
    input.text, input.channelEmotes ?? [], input.fragments ?? null, input.simulationMode === true,
  ]);
  const existingCache = translationCaches.get(translationProvider);
  const cached = existingCache?.get(cacheKey);
  if (cached) {
    metrics.cacheHits++;
    return completed(input, cached);
  }

  const request: TranslationRequest = {
    text: input.text,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    channelEmotes: [...(input.channelEmotes ?? [])],
    ...(input.fragments === undefined ? {} : { fragments: input.fragments.map(fragment => ({ ...fragment })) }),
    simulationMode: input.simulationMode === true,
  };

  const startTime = Date.now();
  let rawResponse: unknown;
  try {
    rawResponse = await translationProvider.translate(request);
  } catch {
    updateAverageLatency(Date.now() - startTime);
    return unavailable(input, 'provider_error');
  }
  updateAverageLatency(Date.now() - startTime);
  const response = translationResponseSchema.safeParse(rawResponse);
  if (!response.success) return unavailable(input, 'provider_error');
  if (!response.data.success) {
    const code = response.data.error.code;
    return unavailable(input, code === 'INVALID_LANGUAGE' ? 'unsupported_language'
      : code === 'TIMEOUT' ? 'timeout' : code === 'RATE_LIMIT' ? 'capacity' : 'provider_error');
  }

  const result = response.data.result;
  if (result.originalText !== input.text || result.sourceLanguage !== input.sourceLanguage ||
      result.targetLanguage !== input.targetLanguage || result.provider !== providerName ||
      result.provenance !== provenance) {
    return unavailable(input, 'provider_error');
  }
  const bubble = completed(input, result);
  metrics.successCount++;
  let cache = translationCaches.get(translationProvider);
  if (!cache) {
    cache = new Map();
    translationCaches.set(translationProvider, cache);
  }
  cacheTranslation(cache, cacheKey, result);
  return bubble;
}

function completed(input: ValidatedMessageOptions, result: TranslationResult): TranslationBubble {
  return translationBubbleSchema.parse({
    status: 'completed',
    messageId: input.messageId, userId: input.userId, displayName: input.displayName,
    original: input.text,
    fragments: input.fragments ?? [{ type: 'text', text: input.text }],
    fromLanguage: result.sourceLanguage, toLanguage: input.targetLanguage,
    illustrativeCountry: null, receivedAtMs: input.receivedAtMs,
    translated: result.translatedText,
  });
}

function unavailable(input: ValidatedMessageOptions, reason: UnavailableReason): TranslationBubble {
  metrics.errorCount++;
  return translationBubbleSchema.parse({
    status: 'unavailable',
    messageId: input.messageId, userId: input.userId, displayName: input.displayName,
    original: input.text,
    fragments: input.fragments ?? [{ type: 'text', text: input.text }],
    fromLanguage: input.sourceLanguage, toLanguage: input.targetLanguage,
    illustrativeCountry: null, receivedAtMs: input.receivedAtMs,
    translated: null, reason,
  });
}

export async function translateMessages(
  messages: TranslateMessageOptions[],
  provider?: TranslationProvider
): Promise<(TranslationBubble | null)[]> {
  const CONCURRENCY = 5;
  const results: (TranslationBubble | null)[] = [];
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const batch = messages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(message => translateMessage(message, provider)));
    results.push(...batchResults);
  }
  return results;
}

export function getTranslationMetrics(): TranslationMetrics {
  return { ...metrics };
}

export function resetTranslationMetrics(): void {
  metrics = { totalRequests: 0, cacheHits: 0, successCount: 0, errorCount: 0, averageLatencyMs: 0 };
  latencySamples = 0;
}

export function clearTranslationCache(): void {
  translationCaches = new WeakMap();
}

function cacheTranslation(cache: Map<string, TranslationResult>, key: string, result: TranslationResult): void {
  cache.set(key, result);
  setTimeout(() => {
    if (cache.get(key) === result) cache.delete(key);
  }, CACHE_TTL_MS);
}

function updateAverageLatency(latencyMs: number): void {
  metrics.averageLatencyMs = (metrics.averageLatencyMs * latencySamples + latencyMs) / (latencySamples + 1);
  latencySamples++;
}
