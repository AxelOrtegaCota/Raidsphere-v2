/**
 * Module B: adapters from the Twitch simulation to the Module D application ports.
 * Roles come from adapter-supplied metadata, never from message text.
 */
import type { StreamerRepository } from '../persistence/contracts.js';
import type {
  ChatCommand, CommandRole, RaidArrival, RaidCancelResult, RaidGateway, RaidRequestResult,
} from '../application/ports.js';
import { parseCommand, type ChatMessage } from './commands.js';
import type { RaidArrivalEvent, RaidOutcomeEvent, SimulatedRaidGateway } from './raids.js';

const MAX_PUBLIC_COUNTDOWN_SECONDS = 120;

/**
 * A broadcaster claim counts only when the sender is the channel owner, so a
 * forged flag on another user cannot grant control (finding F3).
 */
export function commandRole(message: ChatMessage): CommandRole {
  if (message.isBroadcaster === true && message.userId === message.channelId) return 'broadcaster';
  if (message.isModerator === true) return 'moderator';
  return 'viewer';
}

/** Returns null for non-commands and invalid commands; authorization stays in Module D. */
export function toChatCommand(message: ChatMessage): ChatCommand | null {
  const parsed = parseCommand(message);
  if (!parsed || parsed.type === 'error') return null;
  const command: ChatCommand['command'] = parsed.type === 'vote'
    ? { type: 'vote', language: parsed.language }
    : { type: parsed.type };
  return {
    messageId: message.messageId, channelId: parsed.channelId, userId: parsed.userId,
    role: commandRole(message), command,
  };
}

interface TrackedRaid {
  readonly fromChannelId: string;
  operationId: string | null;
  unsubscribe: () => void;
}

export interface RaidGatewayAdapterDependencies {
  gateway: SimulatedRaidGateway;
  streamers: StreamerRepository;
  onArrival: (arrival: RaidArrival) => unknown;
}

/**
 * Exposes the Module B simulated gateway through the Module D raid port.
 * The adapter does not own the gateway; its creator disposes it.
 */
export class RaidGatewayAdapter implements RaidGateway {
  private readonly deps: RaidGatewayAdapterDependencies;
  // sessionId is the idempotency key required by the port.
  private readonly requests = new Map<string, Promise<RaidRequestResult>>();
  private readonly raids = new Map<string, TrackedRaid>();
  private closed = false;

  constructor(dependencies: RaidGatewayAdapterDependencies) {
    this.deps = dependencies;
  }

  requestRaid(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult> {
    const existing = this.requests.get(request.sessionId);
    if (existing) return existing;
    const result = this.start(request);
    this.requests.set(request.sessionId, result);
    return result;
  }

  async cancelRaid(request: { sessionId: string; fromChannelId: string }): Promise<RaidCancelResult> {
    const raid = this.raids.get(request.sessionId);
    if (!raid || raid.fromChannelId !== request.fromChannelId) return 'not_cancelled';
    // The request is still being submitted, so its state cannot be confirmed yet.
    if (raid.operationId === null) return 'unknown';
    try {
      const result = await this.deps.gateway.cancelRaid({
        operationId: raid.operationId, fromStreamerId: raid.fromChannelId,
      });
      return result.status === 'cancelled' ? 'cancelled' : 'not_cancelled';
    } catch {
      return 'unknown';
    }
  }

  close(): void {
    this.closed = true;
    for (const raid of this.raids.values()) raid.unsubscribe();
    this.raids.clear();
  }

  private async start(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult> {
    if (this.closed) return { outcome: 'rejected' };
    const [source, target] = await Promise.all([
      this.deps.streamers.findById(request.fromChannelId),
      this.deps.streamers.findById(request.toStreamerId),
    ]);
    // Without both registered channels no raid is submitted, so the outcome is certain.
    if (!source || !target || this.closed) return { outcome: 'rejected' };

    const raid = this.track(request);
    try {
      const response = await this.deps.gateway.startRaid({
        sessionId: request.sessionId,
        fromStreamerId: source.id, fromLogin: source.login,
        toStreamerId: target.id, toLogin: target.login,
        sourceLanguage: source.language,
      });
      if (!response.success) {
        this.release(request.sessionId, raid);
        return { outcome: 'rejected' };
      }
      raid.operationId = response.operationId;
      return {
        outcome: 'accepted', requestedAtMs: response.requestedAtMs,
        estimatedCountdownSeconds: publicCountdown(response.estimatedCountdownSeconds),
      };
    } catch {
      // The gateway may have registered the operation before failing.
      return { outcome: 'unknown' };
    }
  }

  /**
   * Subscribes before submission: terminal outcomes can arrive before startRaid returns.
   * The terminal outcome carries the arrival, so one subscription observes both.
   */
  private track(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): TrackedRaid {
    const raid: TrackedRaid = { fromChannelId: request.fromChannelId, operationId: null, unsubscribe: () => undefined };
    raid.unsubscribe = this.deps.gateway.onOutcome(request.fromChannelId, async (event: RaidOutcomeEvent) => {
      if (event.sessionId !== request.sessionId || event.toStreamerId !== request.toStreamerId) return;
      this.release(request.sessionId, raid);
      // Other terminal outcomes are left to the coordinator's arrival deadline.
      if (event.outcome === 'arrived' && !this.closed) await this.deps.onArrival(toRaidArrival(event.arrival));
    });
    this.raids.set(request.sessionId, raid);
    return raid;
  }

  private release(sessionId: string, raid: TrackedRaid): void {
    raid.unsubscribe();
    if (this.raids.get(sessionId) === raid) this.raids.delete(sessionId);
  }
}

function toRaidArrival(event: RaidArrivalEvent): RaidArrival {
  return {
    eventId: `raid-arrival-${event.operationId}`,
    fromChannelId: event.fromStreamerId, toChannelId: event.toStreamerId,
    viewers: event.viewers, observedAtMs: event.arrivedAtMs,
  };
}

// The public contract bounds the estimate; an unusable estimate is published as unknown.
function publicCountdown(seconds: number): number | null {
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_PUBLIC_COUNTDOWN_SECONDS ? seconds : null;
}
