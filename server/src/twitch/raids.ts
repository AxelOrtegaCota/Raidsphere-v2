/**
 * Module B: Simulated raid lifecycle, with internal operation correlation.
 * Acceptance is not proof of arrival. Identifiers are not authorization evidence.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  countSchema, identifierSchema, languageCodeSchema, loginSchema, timestampSchema,
} from '@raidsphere/shared';
import type { LanguageCode } from '@raidsphere/shared';

export interface RaidRequest {
  sessionId: string;
  fromStreamerId: string;
  fromLogin: string;
  toStreamerId: string;
  toLogin: string;
  sourceLanguage: LanguageCode;
}

export interface RaidCorrelation extends Readonly<RaidRequest> {
  readonly operationId: string;
  readonly requestedAtMs: number;
}

export type RaidTerminalOutcome = 'arrived' | 'rejected' | 'cancelled' | 'timed_out' | 'unknown';
export type RaidOutcome = 'accepted' | RaidTerminalOutcome;
export type RaidRejectionReason = 'source_busy' | 'target_not_accepting' | 'simulation_error';
export type RaidUnknownReason = 'cleared' | 'gateway_disposed' | 'simulation_error';

export type RaidResponse = Readonly<RaidCorrelation & (
  | { success: true; outcome: 'accepted'; estimatedCountdownSeconds: number }
  | {
    success: false; outcome: 'rejected'; estimatedCountdownSeconds: null;
    reason: RaidRejectionReason; error: string;
  }
)>;

export interface RaidArrivalEvent extends RaidCorrelation {
  readonly viewers: number;
  readonly arrivedAtMs: number;
}

type RaidTerminalDetails =
  | { outcome: 'arrived'; arrival: RaidArrivalEvent }
  | { outcome: 'rejected'; reason: RaidRejectionReason }
  | { outcome: 'cancelled' }
  | { outcome: 'timed_out'; reason: 'observation_timeout' }
  | { outcome: 'unknown'; reason: RaidUnknownReason };

export type RaidOutcomeEvent = Readonly<
  RaidCorrelation & { completedAtMs: number } & RaidTerminalDetails
>;

export interface RaidCancellationRequest {
  operationId: string;
  fromStreamerId: string;
}

export type RaidCancellationResult =
  | Readonly<RaidCorrelation & { status: 'cancelled'; completedAtMs: number }>
  | Readonly<RaidCancellationRequest & { status: 'not_active' }>;

export interface SimulationConfig {
  acceptRate: number;
  arrivalRate: number;
  minCountdownMs: number;
  maxCountdownMs: number;
  observationTimeoutMs: number;
  minViewers: number;
  maxViewers: number;
}

const MAX_TIMER_MS = 2_147_483_647;
const requestSchema = z.object({
  sessionId: identifierSchema,
  fromStreamerId: identifierSchema,
  fromLogin: loginSchema,
  toStreamerId: identifierSchema,
  toLogin: loginSchema,
  sourceLanguage: languageCodeSchema,
}).strict();
const cancellationSchema = z.object({
  operationId: z.string().uuid(),
  fromStreamerId: identifierSchema,
}).strict();
const configSchema = z.object({
  acceptRate: z.number().min(0).max(1),
  arrivalRate: z.number().min(0).max(1),
  minCountdownMs: countSchema.max(MAX_TIMER_MS),
  maxCountdownMs: countSchema.max(MAX_TIMER_MS),
  observationTimeoutMs: countSchema.min(1).max(MAX_TIMER_MS),
  minViewers: countSchema,
  maxViewers: countSchema,
}).strict().refine(config =>
  config.minCountdownMs <= config.maxCountdownMs &&
  config.observationTimeoutMs > config.maxCountdownMs &&
  config.minViewers <= config.maxViewers,
{ message: 'Invalid raid simulation bounds.' });

const DEFAULT_CONFIG: Readonly<SimulationConfig> = Object.freeze({
  acceptRate: 0.9,
  arrivalRate: 0.95,
  minCountdownMs: 2000,
  maxCountdownMs: 8000,
  observationTimeoutMs: 15000,
  minViewers: 5,
  maxViewers: 50,
});
const REJECTION_MESSAGES: Record<RaidRejectionReason, string> = {
  source_busy: 'The source channel already has an active raid operation.',
  target_not_accepting: 'The target channel is not accepting raids.',
  simulation_error: 'The simulated raid request could not be processed.',
};

interface PendingRaid {
  readonly context: RaidCorrelation;
  arrivalTimer: ReturnType<typeof setTimeout> | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Subscription<T> {
  readonly callback: (event: T) => void | Promise<void>;
  active: boolean;
}

export class SimulatedRaidGateway {
  private readonly config: Readonly<SimulationConfig>;
  private readonly pendingRaids = new Map<string, PendingRaid>();
  private readonly activeSources = new Map<string, string>();
  private readonly arrivalCallbacks = new Map<string, Set<Subscription<RaidArrivalEvent>>>();
  private readonly outcomeCallbacks = new Map<string, Set<Subscription<RaidOutcomeEvent>>>();
  private readonly random: () => number;
  private disposed = false;

  constructor(config: Partial<SimulationConfig> = {}, random: () => number = Math.random) {
    const parsed = configSchema.safeParse({ ...DEFAULT_CONFIG, ...config });
    if (!parsed.success || typeof random !== 'function') {
      throw new TypeError('Invalid raid simulation configuration.');
    }
    this.config = Object.freeze(parsed.data);
    this.random = random;
  }

  /**
   * Subscribe before submitting requests: rejection outcomes can be delivered
   * before the caller resumes from this promise. Arrival remains asynchronous.
   */
  async startRaid(request: RaidRequest): Promise<RaidResponse> {
    this.assertOpen();
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new TypeError('Invalid raid request.');

    const context: RaidCorrelation = Object.freeze({
      ...parsed.data,
      operationId: randomUUID(),
      requestedAtMs: timestampSchema.parse(Date.now()),
    });
    const operation: PendingRaid = {
      context, arrivalTimer: undefined, deadlineTimer: undefined,
    };
    this.pendingRaids.set(context.operationId, operation);

    if (this.activeSources.has(context.fromStreamerId)) {
      return this.reject(operation, 'source_busy');
    }
    this.activeSources.set(context.fromStreamerId, context.operationId);

    try {
      const acceptanceDraw = this.draw();
      this.assertStartingOperationActive(operation);
      if (acceptanceDraw >= this.config.acceptRate) {
        return this.reject(operation, 'target_not_accepting');
      }
      const countdownDraw = this.draw();
      this.assertStartingOperationActive(operation);
      const countdownMs = this.config.minCountdownMs +
        countdownDraw * (this.config.maxCountdownMs - this.config.minCountdownMs);

      operation.arrivalTimer = setTimeout(() => {
        operation.arrivalTimer = undefined;
        this.processRaidArrival(context.operationId);
      }, countdownMs);
      operation.deadlineTimer = setTimeout(() => {
        operation.deadlineTimer = undefined;
        this.complete(context.operationId, { outcome: 'timed_out', reason: 'observation_timeout' });
      }, this.config.observationTimeoutMs);

      return Object.freeze({
        ...context, success: true, outcome: 'accepted',
        estimatedCountdownSeconds: Math.round(countdownMs / 1000),
      });
    } catch {
      // A reentrant callback may already have finalized this operation. Preserve
      // that outcome and reject startup instead of issuing a second completion.
      this.assertStartingOperationActive(operation);
      return this.reject(operation, 'simulation_error');
    }
  }

  /** Source matching is correlation protection; callers must enforce authorization. */
  async cancelRaid(request: RaidCancellationRequest): Promise<RaidCancellationResult> {
    const parsed = cancellationSchema.safeParse(request);
    if (!parsed.success) throw new TypeError('Invalid raid cancellation request.');
    const operation = this.pendingRaids.get(parsed.data.operationId);
    if (!operation || operation.context.fromStreamerId !== parsed.data.fromStreamerId) {
      return Object.freeze({ ...parsed.data, status: 'not_active' });
    }
    const event = this.complete(parsed.data.operationId, { outcome: 'cancelled' });
    if (!event) return Object.freeze({ ...parsed.data, status: 'not_active' });
    return Object.freeze({
      ...operation.context, status: 'cancelled', completedAtMs: event.completedAtMs,
    });
  }

  onArrival(toStreamerId: string, callback: (event: RaidArrivalEvent) => void | Promise<void>): () => void {
    return this.subscribe(this.arrivalCallbacks, toStreamerId, callback);
  }

  onOutcome(fromStreamerId: string, callback: (event: RaidOutcomeEvent) => void | Promise<void>): () => void {
    return this.subscribe(this.outcomeCallbacks, fromStreamerId, callback);
  }

  getPendingCount(): number {
    return this.pendingRaids.size;
  }

  /** Finalize the operations present at entry before delivering any cleanup outcomes. */
  clearPending(): readonly RaidOutcomeEvent[] {
    const events = this.finalizePending('cleared');
    for (const event of events) this.deliver(event);
    return events;
  }

  /**
   * Returns pending unknown outcomes without invoking listeners.
   * Already-running asynchronous observers cannot be forcibly stopped.
   */
  dispose(): readonly RaidOutcomeEvent[] {
    if (this.disposed) return Object.freeze([]);
    this.disposed = true;
    this.clearSubscriptions(this.arrivalCallbacks);
    this.clearSubscriptions(this.outcomeCallbacks);
    return this.finalizePending('gateway_disposed');
  }

  private reject(operation: PendingRaid, reason: RaidRejectionReason): RaidResponse {
    this.complete(operation.context.operationId, { outcome: 'rejected', reason });
    return Object.freeze({
      ...operation.context, success: false, outcome: 'rejected',
      estimatedCountdownSeconds: null, reason, error: REJECTION_MESSAGES[reason],
    });
  }

  private processRaidArrival(operationId: string): void {
    const operation = this.pendingRaids.get(operationId);
    if (!operation || this.disposed) return;
    try {
      // Absence of an observation leaves the operation active until its deadline.
      if (this.draw() >= this.config.arrivalRate) return;
      const viewers = countSchema.parse(Math.round(
        this.config.minViewers + this.draw() * (this.config.maxViewers - this.config.minViewers)
      ));
      const arrival: RaidArrivalEvent = Object.freeze({
        ...operation.context, viewers, arrivedAtMs: timestampSchema.parse(Date.now()),
      });
      this.complete(operationId, { outcome: 'arrived', arrival });
    } catch {
      this.complete(operationId, { outcome: 'unknown', reason: 'simulation_error' });
    }
  }

  /** The only terminal transition: release resources before running user callbacks. */
  private complete(
    operationId: string, details: RaidTerminalDetails, notify = true
  ): RaidOutcomeEvent | undefined {
    const operation = this.pendingRaids.get(operationId);
    if (!operation) return undefined;
    const event: RaidOutcomeEvent = Object.freeze({
      ...operation.context, ...details, completedAtMs: timestampSchema.parse(Date.now()),
    });
    this.pendingRaids.delete(operationId);
    if (this.activeSources.get(operation.context.fromStreamerId) === operationId) {
      this.activeSources.delete(operation.context.fromStreamerId);
    }
    if (operation.arrivalTimer !== undefined) clearTimeout(operation.arrivalTimer);
    if (operation.deadlineTimer !== undefined) clearTimeout(operation.deadlineTimer);
    operation.arrivalTimer = undefined;
    operation.deadlineTimer = undefined;
    if (notify) this.deliver(event);
    return event;
  }

  private deliver(event: RaidOutcomeEvent): void {
    this.notify(this.outcomeCallbacks, event.fromStreamerId, event);
    if (event.outcome === 'arrived') {
      this.notify(this.arrivalCallbacks, event.toStreamerId, event.arrival);
    }
  }

  private finalizePending(reason: RaidUnknownReason): readonly RaidOutcomeEvent[] {
    const events: RaidOutcomeEvent[] = [];
    for (const operationId of [...this.pendingRaids.keys()]) {
      const event = this.complete(operationId, { outcome: 'unknown', reason }, false);
      if (event) events.push(event);
    }
    return Object.freeze(events);
  }

  private subscribe<T>(
    registry: Map<string, Set<Subscription<T>>>,
    channelId: string,
    callback: (event: T) => void | Promise<void>
  ): () => void {
    this.assertOpen();
    if (!identifierSchema.safeParse(channelId).success || typeof callback !== 'function') {
      throw new TypeError('Invalid raid subscription.');
    }
    let registrations = registry.get(channelId);
    if (!registrations) {
      registrations = new Set();
      registry.set(channelId, registrations);
    }
    const registration: Subscription<T> = { callback, active: true };
    registrations.add(registration);
    const ownedRegistrations = registrations;
    return () => {
      if (!registration.active) return;
      registration.active = false;
      ownedRegistrations.delete(registration);
      if (ownedRegistrations.size === 0 && registry.get(channelId) === ownedRegistrations) {
        registry.delete(channelId);
      }
    };
  }

  private notify<T>(
    registry: Map<string, Set<Subscription<T>>>, channelId: string, event: T
  ): void {
    const registrations = registry.get(channelId);
    if (!registrations || this.disposed) return;
    for (const registration of [...registrations]) {
      if (this.disposed) break;
      if (!registration.active) continue;
      try {
        // Each observer owns its copy, including nested arrival data.
        Promise.resolve(registration.callback(structuredClone(event))).catch(() => {
          // Observer failures do not change terminal state or expose request data.
        });
      } catch {
        // Continue delivery and preserve the already-completed resource cleanup.
      }
    }
  }

  private clearSubscriptions<T>(registry: Map<string, Set<Subscription<T>>>): void {
    for (const registrations of registry.values()) {
      for (const registration of registrations) registration.active = false;
    }
    registry.clear();
  }

  private draw(): number {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('Invalid raid simulation random value.');
    }
    return value;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('The raid gateway has been disposed.');
  }

  private assertStartingOperationActive(operation: PendingRaid): void {
    const { operationId, fromStreamerId } = operation.context;
    if (this.disposed || this.pendingRaids.get(operationId) !== operation ||
        this.activeSources.get(fromStreamerId) !== operationId) {
      throw new Error('Raid operation was interrupted during startup.');
    }
  }
}

// Replacement does not transfer or dispose ownership of the previous gateway.
let defaultGateway: SimulatedRaidGateway | null = null;

export function getRaidGateway(): SimulatedRaidGateway {
  if (!defaultGateway) defaultGateway = new SimulatedRaidGateway();
  return defaultGateway;
}

export function setRaidGateway(gateway: SimulatedRaidGateway): void {
  defaultGateway = gateway;
}
