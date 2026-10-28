import { randomUUID } from 'node:crypto';
import type { Candidate, IllustrativeCountry, PublicRouletteState, Streamer } from '@raidsphere/shared';
import type { RouletteRepository, StoredRouletteSession, StreamerRepository } from '../persistence/contracts.js';
import { buildPool, eligibleChannels } from './eligibility.js';
import type {
  CandidateSource, ChatCommand, Clock, RaidArrival, RaidGateway, RandomSource, Scheduler, TimerHandle,
} from './ports.js';
import type { EventPublisher } from './publisher.js';
import { pickCandidate, poolLanguages, winningLanguage } from './selection.js';
import { castVote } from './votes.js';

// Authoritative roulette coordinator: state machine (D2-07), commands (D2-05), vote
// broadcasts (D2-08), raid request and arrival (D2-15). Work for one channel runs strictly
// one task at a time, so commands, timers, and arrivals never interleave.

export interface RouletteConfig {
  votingDurationMs: number;
  voteBroadcastIntervalMs: number;
  // Upper bound for each raid gateway call; an expired call counts as an unknown outcome.
  gatewayTimeoutMs: number;
  // Added to the estimated countdown before a missing arrival becomes unknown.
  arrivalGraceMs: number;
}

export const DEFAULT_ROULETTE_CONFIG: RouletteConfig = {
  votingDurationMs: 30_000,
  voteBroadcastIntervalMs: 1_000,
  gatewayTimeoutMs: 10_000,
  arrivalGraceMs: 60_000,
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
  // Reports carry no content, so chat data never reaches logs.
  onError: (kind: 'task_failed') => void;
  config?: Partial<RouletteConfig>;
  createSessionId?: () => string;
}

interface SessionRuntime {
  source: Streamer;
  fromCountry: IllustrativeCountry | null;
  timers: Set<TimerHandle>;
  broadcastTimer: TimerHandle | null;
  lastBroadcastAtMs: number | null;
  lastBroadcastTotal: number;
}

const SEEN_LIMIT = 1_000;
const MESSAGES = {
  noCandidates: 'No eligible channel is live right now.',
  rejected: 'The raid request was rejected.',
  unknown: 'The raid outcome could not be confirmed.',
} as const;

export class RouletteCoordinator {
  readonly #deps: RouletteDependencies;
  readonly #config: RouletteConfig;
  readonly #createSessionId: () => string;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #runtimes = new Map<string, SessionRuntime>();
  readonly #seenMessages = new Map<string, Set<string>>();
  readonly #seenArrivals = new Set<string>();

  constructor(dependencies: RouletteDependencies) {
    this.#deps = dependencies;
    this.#config = { ...DEFAULT_ROULETTE_CONFIG, ...dependencies.config };
    this.#createSessionId = dependencies.createSessionId ?? randomUUID;
  }

  handleCommand(command: ChatCommand): Promise<void> {
    return this.#exclusive(command.channelId, () => this.#onCommand(command));
  }

  handleArrival(arrival: RaidArrival): Promise<void> {
    return this.#exclusive(arrival.fromChannelId, () => this.#onArrival(arrival));
  }

  // Latest session, active or terminal, for per-connection snapshots (D2-07 rule 7).
  async snapshot(channelId: string): Promise<{ roulette: PublicRouletteState | null; translationWindow: null }> {
    const latest = await this.#deps.sessions.findLatestByChannel(channelId);
    return { roulette: latest?.publicState ?? null, translationWindow: null };
  }

  close(): void {
    for (const runtime of this.#runtimes.values()) this.#clearTimers(runtime);
    this.#runtimes.clear();
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

  async #vote(channelId: string, userId: string, language: Candidate['language']): Promise<void> {
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
    const result = await this.#withTimeout(
      () => this.#deps.raids.requestRaid({ sessionId, fromChannelId: channelId, toStreamerId: candidate.streamerId }),
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
    if (!(await this.#save(chosen, { status: 'raid_pending' }))) return;
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
    const current = await this.#deps.sessions.findActiveByChannel(arrival.fromChannelId);
    if (!current || current.publicState.status !== 'raid_pending' ||
        current.publicState.chosenCandidate?.streamerId !== arrival.toChannelId) return;
    const { sessionId } = current.publicState;
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime || !(await this.#save(current, { status: 'done' }))) return;
    this.#endRuntime(sessionId);
    this.#deps.publisher.publish({
      type: 'raid:arrived', channelId: arrival.toChannelId, sessionId,
      payload: {
        fromStreamerId: arrival.fromChannelId, fromLogin: runtime.source.login, toStreamerId: arrival.toChannelId,
        viewers: arrival.viewers, sourceLanguage: runtime.source.language, arrivedAtMs: arrival.observedAtMs,
      },
    });
  }

  // Moves a session to a terminal state, stops its timers, and publishes the matching event.
  async #finish(
    current: StoredRouletteSession,
    status: 'cancelled' | 'failed' | 'unknown',
    reason: 'user_cancelled' | 'session_cancelled_before_request' | 'RAID_REJECTED' | 'RAID_OUTCOME_UNKNOWN',
  ): Promise<void> {
    if (!(await this.#save(current, { status }))) return;
    const { sessionId, fromStreamerId: channelId } = current.publicState;
    this.#endRuntime(sessionId);
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
