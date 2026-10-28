/**
 * Module B: Simulated raid gateway
 * 
 * Simulates Twitch raid API responses for local development.
 * Supports: accepted, rejected, and uncertain outcomes.
 * In Phase 3, this is replaced by real Helix API calls.
 */

import { LanguageCode } from '@raidsphere/shared';

export type RaidOutcome = 'accepted' | 'rejected' | 'arrived' | 'cancelled' | 'timeout' | 'unknown';

export interface RaidRequest {
  fromStreamerId: string;
  fromLogin: string;
  toStreamerId: string;
  toLogin: string;
  sourceLanguage: LanguageCode;
}

export interface RaidResponse {
  success: boolean;
  outcome: RaidOutcome;
  requestedAtMs: number;
  estimatedCountdownSeconds: number | null;
  error?: string;
}

export interface RaidArrivalEvent {
  fromStreamerId: string;
  fromLogin: string;
  toStreamerId: string;
  toLogin: string;
  viewers: number;
  sourceLanguage: LanguageCode;
  arrivedAtMs: number;
}

// Simulated raid outcomes with probabilities
interface SimulationConfig {
  acceptRate: number;        // Probability of raid being accepted (0-1)
  arrivalRate: number;       // Probability of arrival after acceptance (0-1)
  minCountdownMs: number;    // Min time before arrival
  maxCountdownMs: number;    // Max time before arrival
  minViewers: number;        // Min viewers that arrive
  maxViewers: number;        // Max viewers that arrive
}

const DEFAULT_CONFIG: SimulationConfig = {
  acceptRate: 0.9,
  arrivalRate: 0.95,
  minCountdownMs: 2000,
  maxCountdownMs: 8000,
  minViewers: 5,
  maxViewers: 50,
};

export class SimulatedRaidGateway {
  private config: SimulationConfig;
  private pendingRaids: Map<string, RaidRequest> = new Map();
  private arrivalCallbacks: Map<string, (event: RaidArrivalEvent) => void> = new Map();
  private random: () => number;
  
  constructor(config: Partial<SimulationConfig> = {}, random: () => number = Math.random) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.random = random;
  }
  
  /**
   * Simulate starting a raid.
   * Returns immediately with acceptance/rejection.
   * If accepted, schedules arrival event asynchronously.
   */
  async startRaid(request: RaidRequest): Promise<RaidResponse> {
    const requestedAtMs = Date.now();
    const raidId = `${request.fromStreamerId}_${request.toStreamerId}_${requestedAtMs}`;
    
    // Simulate acceptance decision
    if (this.random() > this.config.acceptRate) {
      return {
        success: false,
        outcome: 'rejected',
        requestedAtMs,
        estimatedCountdownSeconds: null,
        error: 'The target channel is not accepting raids.',
      };
    }
    
    // Raid accepted
    this.pendingRaids.set(raidId, request);
    
    const countdownMs = this.config.minCountdownMs + 
      this.random() * (this.config.maxCountdownMs - this.config.minCountdownMs);
    const estimatedCountdownSeconds = Math.round(countdownMs / 1000);
    
    // Schedule arrival (or failure)
    setTimeout(() => {
      this.processRaidArrival(raidId, request);
    }, countdownMs);
    
    return {
      success: true,
      outcome: 'accepted',
      requestedAtMs,
      estimatedCountdownSeconds,
    };
  }
  
  /**
   * Simulate cancelling a pending raid.
   */
  async cancelRaid(fromStreamerId: string, toStreamerId: string): Promise<boolean> {
    // Find and cancel any pending raid
    for (const [raidId, request] of this.pendingRaids.entries()) {
      if (request.fromStreamerId === fromStreamerId && request.toStreamerId === toStreamerId) {
        this.pendingRaids.delete(raidId);
        return true;
      }
    }
    return false;
  }
  
  /**
   * Register callback for raid arrivals.
   * The callback receives the arrival event when a raid completes.
   */
  onArrival(channelId: string, callback: (event: RaidArrivalEvent) => void): () => void {
    this.arrivalCallbacks.set(channelId, callback);
    return () => this.arrivalCallbacks.delete(channelId);
  }
  
  private processRaidArrival(raidId: string, request: RaidRequest): void {
    // Check if still pending (not cancelled)
    if (!this.pendingRaids.has(raidId)) {
      return;
    }
    
    this.pendingRaids.delete(raidId);
    
    // Simulate arrival decision
    if (this.random() > this.config.arrivalRate) {
      // Raid failed/timeout - no arrival event
      return;
    }
    
    // Generate arrival event
    const viewers = Math.round(
      this.config.minViewers + this.random() * (this.config.maxViewers - this.config.minViewers)
    );
    
    const arrivalEvent: RaidArrivalEvent = {
      fromStreamerId: request.fromStreamerId,
      fromLogin: request.fromLogin,
      toStreamerId: request.toStreamerId,
      toLogin: request.toLogin,
      viewers,
      sourceLanguage: request.sourceLanguage,
      arrivedAtMs: Date.now(),
    };
    
    // Notify destination channel
    const callback = this.arrivalCallbacks.get(request.toStreamerId);
    if (callback) {
      callback(arrivalEvent);
    }
  }
  
  /**
   * Get pending raids count (for testing/monitoring).
   */
  getPendingCount(): number {
    return this.pendingRaids.size;
  }
  
  /**
   * Clear all pending raids (for testing/cleanup).
   */
  clearPending(): void {
    this.pendingRaids.clear();
  }
}

// Default instance for the application
let defaultGateway: SimulatedRaidGateway | null = null;

export function getRaidGateway(): SimulatedRaidGateway {
  if (!defaultGateway) {
    defaultGateway = new SimulatedRaidGateway();
  }
  return defaultGateway;
}

export function setRaidGateway(gateway: SimulatedRaidGateway): void {
  defaultGateway = gateway;
}
