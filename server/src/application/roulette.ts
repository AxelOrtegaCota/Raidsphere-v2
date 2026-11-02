import { randomUUID } from 'node:crypto';
import { candidateSchema, languageCodeSchema } from '@raidsphere/shared';
import type {
  Candidate, IllustrativeCountry, LanguageCode, PublicRouletteState, ServerEvent, Streamer, TranslationWindow,
} from '@raidsphere/shared';
import type {
  RouletteRepository, StoredRouletteSession, StreamerRepository, TranslationWindowRepository,
} from '../persistence/contracts.js';
import { InMemoryTranslationWindowRepository } from '../persistence/memory.js';
import { buildPool, eligibleChannels } from './eligibility.js';
import type {
  CandidateSource, ChatCommand, Clock, RaidArrival, RaidGateway, RandomSource, Scheduler, TimerHandle,
} from './ports.js';
import type { EventListener, EventPublisher } from './publisher.js';
import { pickCandidate, poolLanguages, winningLanguage } from './selection.js';
import { TRANSLATION_WINDOW_MS, effectiveWindow, expireWindow, openWindow } from './translation-window.js';
import { castVote } from './votes.js';

// Authoritative roulette coordinator: state machine (D2-07), commands (D2-05), vote
// broadcasts (D2-08), raid request and arrival (D2-15), and the translation window that a
// confirmed arrival opens on the destination (Phase 4, module 3). Work for one channel runs
// strictly one task at a time, so commands, timers, arrivals, and windows never interleave.

export interface RouletteConfig {
  votingDurationMs: number;
  voteBroadcastIntervalMs: number;
  // Upper bound for each raid gateway call; an expired call counts as an unknown outcome.
  gatewayTimeoutMs: number;
  // Added to the estimated countdown before a missing arrival becomes unknown.
  arrivalGraceMs: number;
  // How long a confirmed arrival keeps translation active on the destination.
  translationWindowMs: number;
}

export const DEFAULT_ROULETTE_CONFIG: RouletteConfig = {
  votingDurationMs: 30_000,
  voteBroadcastIntervalMs: 1_000,
  gatewayTimeoutMs: 10_000,
  arrivalGraceMs: 60_000,
  translationWindowMs: TRANSLATION_WINDOW_MS,
};

export interface RouletteDependencies {
  clock: Clock;
  scheduler: Scheduler;
  random: RandomSource;
  streamers: StreamerRepository;
  sessions: RouletteRepository;
  candidates: CandidateSource;
  raids: RaidGateway;
  publisher: EventPublisher;
  // Defaults to process memory, like the other Phase 2 repositories.
  windows?: TranslationWindowRepository;
  // Told after each window change, so translation runs only while a window is active.
  onTranslationWindow?: (window: TranslationWindow) => void;
  // Reports carry no content, so chat data never reaches logs.
  onError: (kind: 'task_failed') => void;
  config?: Partial<RouletteConfig>;
  createSessionId?: () => string;
  canTranslate?: (channelId: string) => boolean;
}

interface SessionRuntime {
  source: Streamer;
  streamLanguage?: string;
  fromCountry: IllustrativeCountry | null;
  timers: Set<TimerHandle>;
  broadcastTimer: TimerHandle | null;
  lastBroadcastAtMs: number | null;
  lastBroadcastTotal: number;
}

const SEEN_LIMIT = 1_000;
export class ControlConflict extends Error {
  readonly statusCode = 409;
}
const MESSAGES = {
  noCandidates: 'No eligible channel is live right now.',
  rejected: 'The raid request was rejected.',
  unknown: 'The raid outcome could not be confirmed.',
} as const;

export class RouletteCoordinator {
  readonly #deps: RouletteDependencies;
  readonly #config: RouletteConfig;
  readonly #createSessionId: () => string;
  readonly #windows: TranslationWindowRepository;
  readonly #windowTimers = new Map<string, TimerHandle>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #runtimes = new Map<string, SessionRuntime>();
  readonly #seenMessages = new Map<string, Set<string>>();
  readonly #seenArrivals = new Set<string>();
  // Never evict an executed browser action: an old request must not become executable again.
  readonly #controlRequests = new Map<string, { fingerprint: string; result: Promise<PublicRouletteState> }>();

  constructor(dependencies: RouletteDependencies) {
    this.#deps = dependencies;
    this.#config = { ...DEFAULT_ROULETTE_CONFIG, ...dependencies.config };
    this.#createSessionId = dependencies.createSessionId ?? randomUUID;
    this.#windows = dependencies.windows ?? new InMemoryTranslationWindowRepository();
    if (!Number.isSafeInteger(this.#config.translationWindowMs) || this.#config.translationWindowMs <= 0) {
      throw new Error('The translation window must last a positive whole number of milliseconds.');
    }
  }

  handleCommand(command: ChatCommand): Promise<void> {
    return this.#exclusive(command.channelId, () => this.#onCommand(command));
  }

  handleArrival(arrival: RaidArrival): Promise<void> {
    return this.#exclusive(arrival.fromChannelId, () => this.#onArrival(arrival));
  }

  browserSpin(source: Streamer, pool: Candidate[], mode: 'manual' | 'auto', requestId: string, sourceLanguage: string = source.language): Promise<PublicRouletteState> {
    return this.#control(source.id, requestId, `spin:${mode}:${pool.map((candidate) => candidate.streamerId).join(',')}`, async () => {
      return (await this.#browserSession(source, pool, mode, sourceLanguage)).publicState;
    });
  }

  browserRaid(source: Streamer, requestId: string, target: Candidate | { sessionId: string }, sourceLanguage: string = source.language): Promise<PublicRouletteState> {
    const identity = 'sessionId' in target ? `session:${target.sessionId}` : `target:${target.streamerId}`;
    return this.#control(source.id, requestId, `raid:${identity}`, async () => {
      let chosen: StoredRouletteSession;
      if ('sessionId' in target) {
        const current = await this.#deps.sessions.findLatestByChannel(source.id);
        if (!current || current.publicState.sessionId !== target.sessionId ||
            !['manual', 'auto'].includes(current.publicState.mode ?? 'chat')) {
          throw new ControlConflict('The selected browser session is no longer available.');
        }
        if (current.publicState.status !== 'chosen') {
          // Repeated explicit clicks for the same session never resubmit its raid.
          if (['raid_pending', 'done', 'failed', 'unknown', 'cancelled'].includes(current.publicState.status)) return current.publicState;
          throw new ControlConflict('This session cannot request a raid.');
        }
        chosen = current;
      } else {
        chosen = await this.#browserSession(source, [target], 'direct', sourceLanguage);
      }
      const candidate = chosen.publicState.chosenCandidate;
      const runtime = this.#runtimes.get(chosen.publicState.sessionId);
      if (!candidate || !runtime) throw new ControlConflict('The selected session expired.');
      await this.#requestRaid(source.id, chosen, candidate, runtime);
      const latest = await this.#deps.sessions.findLatestByChannel(source.id);
      if (!latest) throw new Error('The raid session is unavailable.');
      return latest.publicState;
    });
  }

  browserCancel(channelId: string, sessionId: string, requestId: string): Promise<PublicRouletteState> {
    return this.#control(channelId, requestId, `cancel:${sessionId}`, async () => {
      const current = await this.#deps.sessions.findLatestByChannel(channelId);
      if (!current || current.publicState.sessionId !== sessionId) throw new ControlConflict('This session is no longer current.');
      await this.#cancel(channelId);
      return (await this.#deps.sessions.findLatestByChannel(channelId))!.publicState;
    });
  }

  #control(channelId: string, requestId: string, fingerprint: string, task: () => Promise<PublicRouletteState>): Promise<PublicRouletteState> {
    const key = `${channelId}:${requestId}`;
    const previous = this.#controlRequests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new ControlConflict('This request ID was already used for another action.'));
      return previous.result;
    }
    if (this.#controlRequests.size >= SEEN_LIMIT) return Promise.reject(new ControlConflict('The control action limit was reached. Restart the server only after checking pending raids.'));
    const result = new Promise<PublicRouletteState>((resolve, reject) => {
      void this.#exclusive(channelId, async () => {
        try { resolve(await task()); } catch (error) { reject(error); }
      });
    });
    this.#controlRequests.set(key, { fingerprint, result });
    return result;
  }

  async #browserSession(source: Streamer, candidates: Candidate[], mode: 'manual' | 'auto' | 'direct', sourceLanguage: string): Promise<StoredRouletteSession> {
    const pool = candidates.map((candidate) => candidateSchema.parse(candidate));
    if (!pool.length || pool.length > 100 || new Set(pool.map((candidate) => candidate.streamerId)).size !== pool.length ||
        pool.some((candidate) => candidate.streamerId === source.id)) throw new ControlConflict('Select unique live destinations other than your own channel.');
    const latest = await this.#deps.sessions.findLatestByChannel(source.id);
    if (await this.#deps.sessions.findActiveByChannel(source.id)) throw new ControlConflict('Finish or cancel the current session first.');
    if (latest?.publicState.status === 'unknown') throw new ControlConflict('The previous raid is uncertain. Check Twitch before another raid can be started.');
    const candidate = pool[pool.length === 1 ? 0 : this.#deps.random.nextInt(pool.length)];
    if (!candidate) throw new Error('The random source returned an invalid candidate index.');
    const nowMs = this.#deps.clock.now();
    const session: StoredRouletteSession = {
      version: 1, votesByUser: {}, publicState: {
        sessionId: this.#createSessionId(), fromStreamerId: source.id, mode, status: 'chosen', candidates: pool,
        votes: {}, createdAtMs: nowMs, votingEndsAtMs: null, chosenCandidate: candidate,
      },
    };
    if (!await this.#deps.sessions.compareAndSave(session, null)) throw new ControlConflict('Another session is already active.');
    this.#runtimes.set(session.publicState.sessionId, {
      source, streamLanguage: sourceLanguage, fromCountry: null, timers: new Set(), broadcastTimer: null, lastBroadcastAtMs: null, lastBroadcastTotal: 0,
    });
    const { sessionId } = session.publicState;
    this.#deps.publisher.publish({
      type: 'roulette:start', channelId: source.id, sessionId,
      payload: { candidates: pool, languages: [...new Set(pool.map((entry) => entry.language))], votingEndsAtMs: nowMs + 5_000, mode },
    });
    this.#deps.publisher.publish({
      type: 'roulette:chosen', channelId: source.id, sessionId,
      payload: { candidate, winningLanguage: candidate.language, fromCountry: null, toCountry: candidate.illustrativeCountry },
    });
    return session;
  }

  // Latest session, active or terminal, for per-connection snapshots (D2-07 rule 7).
  async snapshot(channelId: string): Promise<{ roulette: PublicRouletteState | null; translationWindow: TranslationWindow | null }> {
    const latest = await this.#deps.sessions.findLatestByChannel(channelId);
    return { roulette: latest?.publicState ?? null, translationWindow: await this.translationWindow(channelId) };
  }

  // The channel's latest window, reported as expired once its deadline has passed.
  async translationWindow(channelId: string): Promise<TranslationWindow | null> {
    return effectiveWindow(await this.#windows.findByChannel(channelId), this.#deps.clock.now());
  }

  // Reads the state, issues the snapshot, and subscribes within one channel task, so no
  // change can fall between the snapshot and the first live event.
  async openView(channelId: string, listener: EventListener): Promise<{ snapshot: ServerEvent; close: () => void } | null> {
    let view: { snapshot: ServerEvent; close: () => void } | null = null;
    await this.#exclusive(channelId, async () => {
      const latest = await this.#deps.sessions.findLatestByChannel(channelId);
      const translationWindow = await this.translationWindow(channelId);
      const snapshot = this.#deps.publisher.issue({
        type: 'state:snapshot', channelId, payload: { roulette: latest?.publicState ?? null, translationWindow },
      });
      if (snapshot) view = { snapshot, close: this.#deps.publisher.subscribe(channelId, listener) };
    });
    return view;
  }

  close(): void {
    for (const runtime of this.#runtimes.values()) this.#clearTimers(runtime);
    this.#runtimes.clear();
    for (const timer of this.#windowTimers.values()) timer.cancel();
    this.#windowTimers.clear();
  }

  #exclusive(channelId: string, task: () => Promise<void>): Promise<void> {
    const run = (this.#queues.get(channelId) ?? Promise.resolve())
      .then(task)
      .catch(() => this.#deps.onError('task_failed'));
    this.#queues.set(channelId, run);
    void run.then(() => {
      if (this.#queues.get(channelId) === run) this.#queues.delete(channelId);
    });
    return run;
  }

  async #onCommand(command: ChatCommand): Promise<void> {
    const seen = this.#seenMessages.get(command.channelId) ?? new Set<string>();
    this.#seenMessages.set(command.channelId, seen);
    if (!remember(seen, command.messageId)) return;
    if (command.command.type === 'vote') {
      await this.#vote(command.channelId, command.userId, command.command.language);
      return;
    }
    // Unauthorized commands are ignored silently (D2-05).
    const authorized = command.role === 'moderator' ||
      (command.role === 'broadcaster' && command.userId === command.channelId);
    if (!authorized) return;
    if (command.command.type === 'roulette') await this.#start(command.channelId);
    else await this.#cancel(command.channelId);
  }

  async #start(channelId: string): Promise<void> {
    const { sessions, streamers, candidates, publisher, random, clock } = this.#deps;
    if (await sessions.findActiveByChannel(channelId)) return;
    const source = await streamers.findById(channelId);
    if (!source) return;
    const live = await candidates.listLiveChannels();
    const eligible = eligibleChannels(source, live);
    if (eligible.length === 0) {
      publisher.publish({
        type: 'error', channelId, payload: { code: 'NO_ELIGIBLE_CANDIDATES', message: MESSAGES.noCandidates, recoverable: true },
      });
      return;
    }
    const pool = buildPool(eligible, random);
    const nowMs = clock.now();
    const sessionId = this.#createSessionId();
    const votingEndsAtMs = nowMs + this.#config.votingDurationMs;
    const session: StoredRouletteSession = {
      version: 1, votesByUser: {},
      publicState: {
        sessionId, fromStreamerId: channelId, status: 'voting', candidates: pool,
        votes: {}, createdAtMs: nowMs, votingEndsAtMs, chosenCandidate: null,
      },
    };
    if (!(await sessions.compareAndSave(session, null))) return;
    const runtime: SessionRuntime = {
      source, fromCountry: live.find((channel) => channel.streamer.id === channelId)?.illustrativeCountry ?? null,
      timers: new Set(), broadcastTimer: null, lastBroadcastAtMs: null, lastBroadcastTotal: 0,
    };
    this.#runtimes.set(sessionId, runtime);
    publisher.publish({
      type: 'roulette:start', channelId, sessionId,
      payload: { candidates: pool, languages: poolLanguages(pool), votingEndsAtMs },
    });
    this.#schedule(runtime, this.#config.votingDurationMs, channelId, () => this.#closeVoting(channelId, sessionId));
  }

  async #vote(channelId: string, userId: string, language: LanguageCode): Promise<void> {
    const current = await this.#deps.sessions.findActiveByChannel(channelId);
    if (!current) return;
    const result = castVote(current.publicState, current.votesByUser, { userId, language }, this.#deps.clock.now());
    if (result.outcome !== 'accepted') return;
    const next = await this.#save(current, { votes: result.votes }, result.votesByUser);
    if (next) this.#requestVoteBroadcast(channelId, next.publicState);
  }

  // At most one roulette:votes per interval, only when counts changed (D2-08).
  #requestVoteBroadcast(channelId: string, state: PublicRouletteState): void {
    const runtime = this.#runtimes.get(state.sessionId);
    if (!runtime || runtime.broadcastTimer) return;
    const { lastBroadcastAtMs } = runtime;
    const waitMs = lastBroadcastAtMs === null
      ? 0 : Math.max(0, lastBroadcastAtMs + this.#config.voteBroadcastIntervalMs - this.#deps.clock.now());
    if (waitMs === 0) {
      this.#publishVotesIfChanged(channelId, runtime, state);
      return;
    }
    runtime.broadcastTimer = this.#schedule(runtime, waitMs, channelId, async () => {
      runtime.broadcastTimer = null;
      const current = await this.#deps.sessions.findActiveByChannel(channelId);
      if (current?.publicState.sessionId === state.sessionId && current.publicState.status === 'voting') {
        this.#publishVotesIfChanged(channelId, runtime, current.publicState);
      }
    });
  }

  #publishVotesIfChanged(channelId: string, runtime: SessionRuntime, state: PublicRouletteState): void {
    const totalVotes = Object.values(state.votes).reduce((sum, count) => sum + (count ?? 0), 0);
    if (totalVotes === runtime.lastBroadcastTotal) return;
    this.#deps.publisher.publish({
      type: 'roulette:votes', channelId, sessionId: state.sessionId, payload: { votes: { ...state.votes }, totalVotes },
    });
    runtime.lastBroadcastTotal = totalVotes;
    runtime.lastBroadcastAtMs = this.#deps.clock.now();
  }

  async #closeVoting(channelId: string, sessionId: string): Promise<void> {
    const current = await this.#activeSession(channelId, sessionId, 'voting');
    const runtime = this.#runtimes.get(sessionId);
    if (!current || !runtime) return;
    runtime.broadcastTimer?.cancel();
    runtime.broadcastTimer = null;
    this.#publishVotesIfChanged(channelId, runtime, current.publicState);
    const selecting = await this.#save(current, { status: 'selecting' });
    if (!selecting) return;
    const { candidates, votes } = selecting.publicState;
    const language = winningLanguage(votes, poolLanguages(candidates), this.#deps.random);
    const candidate = pickCandidate(candidates, language, this.#deps.random);
    const chosen = await this.#save(selecting, { status: 'chosen', chosenCandidate: candidate });
    if (!chosen) return;
    this.#deps.publisher.publish({
      type: 'roulette:chosen', channelId, sessionId,
      payload: { candidate, winningLanguage: language, fromCountry: runtime.fromCountry, toCountry: candidate.illustrativeCountry },
    });
    await this.#requestRaid(channelId, chosen, candidate, runtime);
  }

  // The raid is requested as soon as a candidate is chosen (D2-07 rule 4).
  async #requestRaid(channelId: string, chosen: StoredRouletteSession, candidate: Candidate, runtime: SessionRuntime): Promise<void> {
    const { sessionId } = chosen.publicState;
    const requesting = await this.#save(chosen, { raidRequestedAtMs: this.#deps.clock.now() });
    if (!requesting) return;
    chosen = requesting;
    const result = await this.#withTimeout(
      () => this.#deps.raids.requestRaid({
        sessionId, fromChannelId: channelId, toStreamerId: candidate.streamerId,
        ...(chosen.publicState.mode && chosen.publicState.mode !== 'chat' ? { toLogin: candidate.login } : {}),
      }),
      { outcome: 'unknown' as const },
    );
    if (result.outcome === 'rejected') {
      await this.#finish(chosen, 'failed', 'RAID_REJECTED');
      return;
    }
    if (result.outcome === 'unknown') {
      await this.#finish(chosen, 'unknown', 'RAID_OUTCOME_UNKNOWN');
      return;
    }
    if (!(await this.#save(chosen, {
      status: 'raid_pending', raidRequestedAtMs: result.requestedAtMs, estimatedCountdownSeconds: result.estimatedCountdownSeconds,
    }))) return;
    this.#deps.publisher.publish({
      type: 'raid:started', channelId, sessionId,
      payload: {
        toStreamerId: candidate.streamerId, toLogin: candidate.login,
        requestedAtMs: result.requestedAtMs, estimatedCountdownSeconds: result.estimatedCountdownSeconds,
      },
    });
    // Success is never assumed: a missing arrival becomes unknown (D2-15 rule 4).
    const deadlineMs = (result.estimatedCountdownSeconds ?? 0) * 1_000 + this.#config.arrivalGraceMs;
    this.#schedule(runtime, deadlineMs, channelId, async () => {
      const pending = await this.#activeSession(channelId, sessionId, 'raid_pending');
      if (pending) await this.#finish(pending, 'unknown', 'RAID_OUTCOME_UNKNOWN');
    });
  }

  async #cancel(channelId: string): Promise<void> {
    const current = await this.#deps.sessions.findActiveByChannel(channelId);
    if (!current) return;
    const { status } = current.publicState;
    if (status === 'voting' || status === 'chosen') {
      await this.#finish(current, 'cancelled', 'session_cancelled_before_request');
      return;
    }
    // The instantaneous selecting state is never interrupted.
    if (status !== 'raid_pending') return;
    const result = await this.#withTimeout(
      () => this.#deps.raids.cancelRaid({ sessionId: current.publicState.sessionId, fromChannelId: channelId }),
      'unknown' as const,
    );
    if (result === 'cancelled') await this.#finish(current, 'cancelled', 'user_cancelled');
    else if (result === 'unknown') await this.#finish(current, 'unknown', 'RAID_OUTCOME_UNKNOWN');
    // not_cancelled: the raid continues and the session stays pending.
  }

  async #onArrival(arrival: RaidArrival): Promise<void> {
    if (!remember(this.#seenArrivals, arrival.eventId)) return;
    const current = await this.#deps.sessions.findLatestByChannel(arrival.fromChannelId);
    if (!current || !['raid_pending', 'unknown'].includes(current.publicState.status) ||
        arrival.observedAtMs < (current.publicState.raidRequestedAtMs ?? current.publicState.createdAtMs) ||
        current.publicState.chosenCandidate?.streamerId !== arrival.toChannelId) return;
    const { sessionId } = current.publicState;
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) return;
    const done = await this.#save(current, { status: 'done' });
    if (!done) return;
    this.#endRuntime(sessionId);
    this.#deps.publisher.publish({
      type: 'raid:arrived', channelId: arrival.toChannelId, sessionId,
      payload: {
        fromStreamerId: arrival.fromChannelId, fromLogin: runtime.source.login, toStreamerId: arrival.toChannelId,
        viewers: arrival.viewers, sourceLanguage: runtime.streamLanguage ?? runtime.source.language, arrivedAtMs: arrival.observedAtMs,
      },
    });
    // raid:arrived only reaches the destination, so the source gets its final state as a snapshot (D2-19).
    this.#deps.publisher.publish({
      type: 'state:snapshot', channelId: arrival.fromChannelId,
      payload: { roulette: done.publicState, translationWindow: await this.translationWindow(arrival.fromChannelId) },
    });
    const targetLanguage = languageCodeSchema.safeParse(done.publicState.chosenCandidate?.language);
    const registered = await this.#deps.streamers.findById(arrival.toChannelId);
    // The window belongs to the destination, so it opens in the destination's channel queue.
    if (registered && targetLanguage.success && (this.#deps.canTranslate?.(arrival.toChannelId) ?? true)) {
      void this.#exclusive(arrival.toChannelId, () => this.#openWindow(arrival.toChannelId, targetLanguage.data));
    }
  }

  // A later arrival replaces an active window and restarts its full duration.
  async #openWindow(channelId: string, targetLanguage: LanguageCode): Promise<void> {
    const window = openWindow(channelId, targetLanguage, this.#deps.clock.now(), this.#config.translationWindowMs);
    await this.#windows.save(window);
    this.#windowTimers.get(channelId)?.cancel();
    this.#windowTimers.set(channelId, this.#deps.scheduler.schedule(this.#config.translationWindowMs, () => {
      void this.#exclusive(channelId, () => this.#expireWindow(channelId, window.activatedAtMs));
    }));
    this.#deps.publisher.publish({ type: 'translation:window', channelId, payload: window });
    this.#deps.onTranslationWindow?.(window);
  }

  // A stale timer finds a replaced window and does nothing.
  async #expireWindow(channelId: string, activatedAtMs: number): Promise<void> {
    const current = await this.#windows.findByChannel(channelId);
    if (!current || current.status !== 'active' || current.activatedAtMs !== activatedAtMs) return;
    this.#windowTimers.delete(channelId);
    const expired = expireWindow(current);
    await this.#windows.save(expired);
    this.#deps.publisher.publish({ type: 'translation:window', channelId, payload: expired });
    this.#deps.onTranslationWindow?.(expired);
  }

  // Moves a session to a terminal state, stops its timers, and publishes the matching event.
  async #finish(
    current: StoredRouletteSession,
    status: 'cancelled' | 'failed' | 'unknown',
    reason: 'user_cancelled' | 'session_cancelled_before_request' | 'RAID_REJECTED' | 'RAID_OUTCOME_UNKNOWN',
  ): Promise<void> {
    if (!(await this.#save(current, { status }))) return;
    const { sessionId, fromStreamerId: channelId } = current.publicState;
    if (status === 'unknown' && current.publicState.mode && current.publicState.mode !== 'chat') {
      // Keep a short correlation window for a late, authoritative EventSub arrival.
      const runtime = this.#runtimes.get(sessionId);
      if (runtime) {
        this.#clearTimers(runtime);
        this.#schedule(runtime, 120_000 + this.#config.arrivalGraceMs, channelId, async () => { this.#endRuntime(sessionId); });
      }
    } else this.#endRuntime(sessionId);
    const { publisher } = this.#deps;
    if (reason === 'user_cancelled' || reason === 'session_cancelled_before_request') {
      publisher.publish({ type: 'raid:cancelled', channelId, sessionId, payload: { reason } });
    } else {
      publisher.publish({
        type: 'error', channelId, sessionId,
        payload: reason === 'RAID_REJECTED'
          ? { code: reason, message: MESSAGES.rejected, recoverable: true }
          : { code: reason, message: MESSAGES.unknown, recoverable: false },
      });
    }
  }

  async #activeSession(channelId: string, sessionId: string, status: PublicRouletteState['status']) {
    const current = await this.#deps.sessions.findActiveByChannel(channelId);
    return current?.publicState.sessionId === sessionId && current.publicState.status === status ? current : null;
  }

  async #save(
    current: StoredRouletteSession,
    changes: Partial<PublicRouletteState>,
    votesByUser = current.votesByUser,
  ): Promise<StoredRouletteSession | null> {
    const next: StoredRouletteSession = {
      version: current.version + 1, votesByUser, publicState: { ...current.publicState, ...changes },
    };
    return (await this.#deps.sessions.compareAndSave(next, current.version)) ? next : null;
  }

  // Timers re-enter through the channel queue; stale timers find a changed session and do nothing.
  #schedule(runtime: SessionRuntime, delayMs: number, channelId: string, task: () => Promise<void>): TimerHandle {
    const handle = this.#deps.scheduler.schedule(delayMs, () => {
      runtime.timers.delete(handle);
      void this.#exclusive(channelId, task);
    });
    runtime.timers.add(handle);
    return handle;
  }

  #endRuntime(sessionId: string): void {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) this.#clearTimers(runtime);
    this.#runtimes.delete(sessionId);
  }

  #clearTimers(runtime: SessionRuntime): void {
    for (const timer of runtime.timers) timer.cancel();
    runtime.timers.clear();
    runtime.broadcastTimer = null;
  }

  // Bounds an adapter call; a rejection or an expired call yields the fallback. Never retried.
  async #withTimeout<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    let timer: TimerHandle | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = this.#deps.scheduler.schedule(this.#config.gatewayTimeoutMs, () => resolve(fallback));
    });
    try {
      return await Promise.race([Promise.resolve().then(call).catch(() => fallback), expired]);
    } finally {
      timer?.cancel();
    }
  }
}

// Bounded duplicate detection; the oldest entries are forgotten first.
function remember(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}
