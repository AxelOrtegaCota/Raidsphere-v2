import type { Clock, Scheduler, TimerHandle } from './ports.js';
import type { EventPublisher, ServerEventDraft } from './publisher.js';

/**
 * Flag manager configuration for channel points-based country flag competition.
 */
export interface FlagManagerConfig {
  /** Points required to complete/claim a flag (default: 10000) */
  pointsThreshold: number;
  /** Points lost per hour due to decay (default: 100) */
  decayRatePerHour: number;
  /** Interval in ms between decay checks (default: 60000) */
  decayCheckIntervalMs: number;
}

export const DEFAULT_FLAG_MANAGER_CONFIG: FlagManagerConfig = {
  pointsThreshold: 10_000,
  decayRatePerHour: 100,
  decayCheckIntervalMs: 60_000,
};

/**
 * Represents a streamer's contribution to a country flag.
 */
export interface StreamerContribution {
  points: number;
  lastContributedAt: number;
  displayName: string;
  avatarUrl: string;
}

/**
 * Represents the current owner of a country flag.
 */
export interface FlagOwner {
  streamerId: string;
  claimedAt: number;
  totalPoints: number;
}

/**
 * Full state for a country's flag competition.
 */
export interface CountryFlagData {
  countryCode: string;
  contributions: Map<string, StreamerContribution>;
  currentOwner: FlagOwner | null;
  lastDecayCheck: number;
}

/**
 * Public summary of a flag's state for external consumers.
 */
export interface FlagSummary {
  countryCode: string;
  owner: { streamerId: string; displayName: string; avatarUrl: string } | null;
  progress: Array<{
    streamerId: string;
    displayName: string;
    avatarUrl: string;
    points: number;
    percentage: number;
  }>;
}

export interface FlagManagerDependencies {
  clock: Clock;
  scheduler: Scheduler;
  publisher: EventPublisher;
  config?: Partial<FlagManagerConfig>;
}

/**
 * Authoritative flag competition manager: handles channel points contributions,
 * flag claiming, competition, and point decay.
 *
 * The flag belongs to whoever has the most points above the threshold.
 * If no one is above threshold, no flag is shown.
 */
export class FlagManager {
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #publisher: EventPublisher;
  readonly #config: FlagManagerConfig;
  readonly #flags = new Map<string, CountryFlagData>();
  #decayTimer: TimerHandle | null = null;

  constructor(deps: FlagManagerDependencies) {
    this.#clock = deps.clock;
    this.#scheduler = deps.scheduler;
    this.#publisher = deps.publisher;
    this.#config = { ...DEFAULT_FLAG_MANAGER_CONFIG, ...deps.config };

    if (this.#config.pointsThreshold <= 0) {
      throw new Error('Points threshold must be positive.');
    }
    if (this.#config.decayRatePerHour < 0) {
      throw new Error('Decay rate cannot be negative.');
    }

    this.#startDecayTimer();
  }

  /**
   * Contribute points to a country flag on behalf of a streamer.
   * Checks for threshold completion, ownership changes, and emits relevant events.
   *
   * @param streamerId - The streamer contributing points
   * @param countryCode - ISO country code being contributed to
   * @param points - Number of points to contribute
   * @param displayName - Streamer's display name
   * @param avatarUrl - Streamer's avatar URL
   */
  async contribute(
    streamerId: string,
    countryCode: string,
    points: number,
    displayName: string,
    avatarUrl: string,
  ): Promise<void> {
    if (points <= 0) return;

    const nowMs = this.#clock.now();
    let flagData = this.#flags.get(countryCode);

    if (!flagData) {
      flagData = {
        countryCode,
        contributions: new Map(),
        currentOwner: null,
        lastDecayCheck: nowMs,
      };
      this.#flags.set(countryCode, flagData);
    }

    // Get or create streamer's contribution
    const existing = flagData.contributions.get(streamerId);
    const newPoints = (existing?.points ?? 0) + points;

    flagData.contributions.set(streamerId, {
      points: newPoints,
      lastContributedAt: nowMs,
      displayName,
      avatarUrl,
    });

    const previousOwner = flagData.currentOwner;

    // Check if this contribution completes/claims the flag
    if (newPoints >= this.#config.pointsThreshold) {
      // Check if this overtakes the current owner
      if (previousOwner && previousOwner.streamerId !== streamerId) {
        const previousOwnerContribution = flagData.contributions.get(previousOwner.streamerId);
        const previousOwnerPoints = previousOwnerContribution?.points ?? 0;

        if (newPoints > previousOwnerPoints) {
          // Overtake the previous owner
          flagData.currentOwner = {
            streamerId,
            claimedAt: nowMs,
            totalPoints: newPoints,
          };

          this.#publishFlagEvent('flag:overtaken', countryCode, {
            countryCode,
            newOwner: { streamerId, displayName, avatarUrl, points: newPoints },
            previousOwner: {
              streamerId: previousOwner.streamerId,
              displayName: previousOwnerContribution?.displayName ?? '',
              avatarUrl: previousOwnerContribution?.avatarUrl ?? '',
              points: previousOwnerPoints,
            },
          });
        }
      } else if (!previousOwner) {
        // First claim of the flag
        flagData.currentOwner = {
          streamerId,
          claimedAt: nowMs,
          totalPoints: newPoints,
        };

        this.#publishFlagEvent('flag:claimed', countryCode, {
          countryCode,
          owner: { streamerId, displayName, avatarUrl, points: newPoints },
        });
      } else {
        // Update existing owner's points
        flagData.currentOwner = {
          ...previousOwner,
          totalPoints: newPoints,
        };
      }
    }

    // Emit contribution event
    this.#publishFlagEvent('flag:contribution', countryCode, {
      countryCode,
      streamerId,
      displayName,
      avatarUrl,
      pointsAdded: points,
      totalPoints: newPoints,
      threshold: this.#config.pointsThreshold,
      percentage: Math.min(100, (newPoints / this.#config.pointsThreshold) * 100),
    });
  }

  /**
   * Get the current state of a country's flag.
   *
   * @param countryCode - ISO country code
   * @returns Country flag data or null if no contributions exist
   */
  getCountryState(countryCode: string): CountryFlagData | null {
    return this.#flags.get(countryCode) ?? null;
  }

  /**
   * Get a summary of all flags with their owners and progress.
   *
   * @returns Array of flag summaries showing ownership and contributor progress
   */
  getAllFlags(): FlagSummary[] {
    const summaries: FlagSummary[] = [];

    for (const [countryCode, data] of this.#flags) {
      const ownerContribution = data.currentOwner
        ? data.contributions.get(data.currentOwner.streamerId)
        : null;

      const progress = Array.from(data.contributions.entries())
        .map(([streamerId, contrib]) => ({
          streamerId,
          displayName: contrib.displayName,
          avatarUrl: contrib.avatarUrl,
          points: contrib.points,
          percentage: Math.min(100, (contrib.points / this.#config.pointsThreshold) * 100),
        }))
        .sort((a, b) => b.points - a.points);

      summaries.push({
        countryCode,
        owner:
          data.currentOwner && ownerContribution
            ? {
                streamerId: data.currentOwner.streamerId,
                displayName: ownerContribution.displayName,
                avatarUrl: ownerContribution.avatarUrl,
              }
            : null,
        progress,
      });
    }

    return summaries;
  }

  /**
   * Clean up resources (timers).
   */
  close(): void {
    if (this.#decayTimer) {
      this.#decayTimer.cancel();
      this.#decayTimer = null;
    }
  }

  /**
   * Start the periodic decay check timer.
   */
  #startDecayTimer(): void {
    if (this.#config.decayRatePerHour === 0) return;

    this.#decayTimer = this.#scheduler.schedule(this.#config.decayCheckIntervalMs, () => {
      this.#applyDecay();
      // Re-schedule for continuous decay checks
      this.#startDecayTimer();
    });
  }

  /**
   * Apply point decay to all contributions based on time elapsed.
   * Emits flag:decayed if an owner loses their flag due to decay.
   */
  #applyDecay(): void {
    const nowMs = this.#clock.now();

    for (const [countryCode, data] of this.#flags) {
      const elapsedHours = (nowMs - data.lastDecayCheck) / (1000 * 60 * 60);
      const decayAmount = Math.floor(this.#config.decayRatePerHour * elapsedHours);

      if (decayAmount <= 0) continue;

      data.lastDecayCheck = nowMs;
      const previousOwner = data.currentOwner;

      // Apply decay to all contributions
      for (const [streamerId, contrib] of data.contributions) {
        const newPoints = Math.max(0, contrib.points - decayAmount);
        contrib.points = newPoints;

        // Remove contributions that have decayed to zero
        if (newPoints === 0) {
          data.contributions.delete(streamerId);
        }
      }

      // Re-evaluate ownership after decay
      const newLeader = this.#findLeader(data);

      if (previousOwner) {
        const previousOwnerContrib = data.contributions.get(previousOwner.streamerId);
        const previousOwnerPoints = previousOwnerContrib?.points ?? 0;

        if (previousOwnerPoints < this.#config.pointsThreshold) {
          // Previous owner no longer qualifies
          if (newLeader && newLeader.points >= this.#config.pointsThreshold) {
            // New leader takes over
            data.currentOwner = {
              streamerId: newLeader.streamerId,
              claimedAt: nowMs,
              totalPoints: newLeader.points,
            };

            const newOwnerContrib = data.contributions.get(newLeader.streamerId);
            this.#publishFlagEvent('flag:decayed', countryCode, {
              countryCode,
              lostOwner: {
                streamerId: previousOwner.streamerId,
                displayName: previousOwnerContrib?.displayName ?? '',
                avatarUrl: previousOwnerContrib?.avatarUrl ?? '',
                previousPoints: previousOwner.totalPoints,
                currentPoints: previousOwnerPoints,
              },
              newOwner: newOwnerContrib
                ? {
                    streamerId: newLeader.streamerId,
                    displayName: newOwnerContrib.displayName,
                    avatarUrl: newOwnerContrib.avatarUrl,
                    points: newLeader.points,
                  }
                : null,
            });
          } else {
            // No one qualifies anymore
            data.currentOwner = null;

            this.#publishFlagEvent('flag:decayed', countryCode, {
              countryCode,
              lostOwner: {
                streamerId: previousOwner.streamerId,
                displayName: previousOwnerContrib?.displayName ?? '',
                avatarUrl: previousOwnerContrib?.avatarUrl ?? '',
                previousPoints: previousOwner.totalPoints,
                currentPoints: previousOwnerPoints,
              },
              newOwner: null,
            });
          }
        } else {
          // Previous owner still qualifies, update their total
          data.currentOwner = {
            ...previousOwner,
            totalPoints: previousOwnerPoints,
          };
        }
      }

      // Clean up empty flags
      if (data.contributions.size === 0) {
        this.#flags.delete(countryCode);
      }
    }
  }

  /**
   * Find the streamer with the most points for a given flag.
   */
  #findLeader(data: CountryFlagData): { streamerId: string; points: number } | null {
    let leader: { streamerId: string; points: number } | null = null;

    for (const [streamerId, contrib] of data.contributions) {
      if (!leader || contrib.points > leader.points) {
        leader = { streamerId, points: contrib.points };
      }
    }

    return leader;
  }

  /**
   * Publish a flag-related event through the event publisher.
   */
  #publishFlagEvent(type: string, channelId: string, payload: Record<string, unknown>): void {
    // Note: Flag events use countryCode as channelId for routing
    // In production, this may need adjustment based on event routing requirements
    this.#publisher.publish({
      type,
      channelId,
      payload,
    } as ServerEventDraft);
  }
}
