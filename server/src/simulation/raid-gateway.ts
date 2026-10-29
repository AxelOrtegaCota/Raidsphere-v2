import type {
  Clock, RaidArrival, RaidCancelResult, RaidGateway, RaidRequestResult, Scheduler, TimerHandle,
} from '../application/ports.js';
import { syntheticLiveChannels } from './fixtures.js';

// Simulated raid gateway for Phase 2 (D2-15). No Twitch request is made, and no real raid happens.

export interface SimulatedRaidOptions {
  requestOutcome: 'accepted' | 'rejected' | 'unknown';
  // Published as estimatedCountdownSeconds, whose contract maximum is 120.
  countdownSeconds: number;
  deliverArrival: boolean;
  cancelOutcome: RaidCancelResult;
}

export const DEFAULT_SIMULATED_RAID_OPTIONS: SimulatedRaidOptions = {
  requestOutcome: 'accepted',
  countdownSeconds: 90,
  deliverArrival: true,
  cancelOutcome: 'cancelled',
};

interface SimulatedRaid {
  result: RaidRequestResult;
  arrivalTimer: TimerHandle | null;
}

export class SimulatedRaidGateway implements RaidGateway {
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #onArrival: (arrival: RaidArrival) => unknown;
  readonly #options: SimulatedRaidOptions;
  readonly #raids = new Map<string, SimulatedRaid>();

  constructor(dependencies: {
    clock: Clock;
    scheduler: Scheduler;
    onArrival: (arrival: RaidArrival) => unknown;
    options?: Partial<SimulatedRaidOptions>;
  }) {
    this.#clock = dependencies.clock;
    this.#scheduler = dependencies.scheduler;
    this.#onArrival = dependencies.onArrival;
    this.#options = { ...DEFAULT_SIMULATED_RAID_OPTIONS, ...dependencies.options };
    const { countdownSeconds } = this.#options;
    if (!Number.isInteger(countdownSeconds) || countdownSeconds < 0 || countdownSeconds > 120) {
      throw new Error('The simulated countdown must be an integer from 0 to 120 seconds.');
    }
  }

  // Idempotent per session: a repeated request returns the first result and schedules nothing new.
  async requestRaid(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult> {
    const existing = this.#raids.get(request.sessionId);
    if (existing) return existing.result;
    const { requestOutcome, countdownSeconds, deliverArrival } = this.#options;
    if (requestOutcome !== 'accepted') {
      const result: RaidRequestResult = { outcome: requestOutcome };
      this.#raids.set(request.sessionId, { result, arrivalTimer: null });
      return result;
    }
    const result: RaidRequestResult = {
      outcome: 'accepted', requestedAtMs: this.#clock.now(), estimatedCountdownSeconds: countdownSeconds,
    };
    const arrivalTimer = deliverArrival
      // The coordinator reports its own failures; a failed delivery must not become an unhandled rejection.
      ? this.#scheduler.schedule(countdownSeconds * 1_000, () => { void this.#deliver(request).catch(() => undefined); })
      : null;
    this.#raids.set(request.sessionId, { result, arrivalTimer });
    return result;
  }

  async cancelRaid(request: { sessionId: string; fromChannelId: string }): Promise<RaidCancelResult> {
    const outcome = this.#options.cancelOutcome;
    if (outcome === 'cancelled') {
      const raid = this.#raids.get(request.sessionId);
      raid?.arrivalTimer?.cancel();
      if (raid) raid.arrivalTimer = null;
    }
    return outcome;
  }

  close(): void {
    for (const raid of this.#raids.values()) raid.arrivalTimer?.cancel();
    this.#raids.clear();
  }

  async #deliver(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<void> {
    const raid = this.#raids.get(request.sessionId);
    if (raid) raid.arrivalTimer = null;
    const viewers = syntheticLiveChannels.find((channel) => channel.streamer.id === request.fromChannelId)?.viewers ?? 0;
    await this.#onArrival({
      eventId: `sim-arrival-${request.sessionId}`, fromChannelId: request.fromChannelId,
      toChannelId: request.toStreamerId, viewers, observedAtMs: this.#clock.now(),
    });
  }
}
