import type { IllustrativeCountry, LanguageCode, Streamer } from '@raidsphere/shared';

// Server-internal ports between the roulette logic and its runtime or adapters (D2-09, D2-13).
// These are not shared contracts; adapters validate external data before calling in.

export interface Clock {
  // Current time in Unix milliseconds.
  now(): number;
}

export interface TimerHandle {
  cancel(): void;
}

export interface Scheduler {
  schedule(delayMs: number, callback: () => void): TimerHandle;
}

export interface RandomSource {
  // Uniform integer in [0, maxExclusive).
  nextInt(maxExclusive: number): number;
}

export type CommandRole = 'broadcaster' | 'moderator' | 'viewer';

// Roles come from the adapter, never from message text (D2-05).
export interface ChatCommand {
  messageId: string;
  channelId: string;
  userId: string;
  role: CommandRole;
  command: { type: 'roulette' } | { type: 'cancel' } | { type: 'vote'; language: LanguageCode };
}

// A registered channel that is live, with the metadata needed for a public candidate.
export interface LiveChannel {
  streamer: Streamer;
  viewers: number;
  gameName: string;
  title: string;
  illustrativeCountry: IllustrativeCountry | null;
}

export interface CandidateSource {
  // Eligibility filters are applied by the roulette logic, not by the source (D2-06).
  listLiveChannels(): Promise<readonly LiveChannel[]>;
}

export type RaidRequestResult =
  | { outcome: 'accepted'; requestedAtMs: number; estimatedCountdownSeconds: number | null }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' };

export type RaidCancelResult = 'cancelled' | 'not_cancelled' | 'unknown';

// sessionId is the idempotency key; callers bound each call with a timeout that yields unknown.
export interface RaidGateway {
  requestRaid(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult>;
  cancelRaid(request: { sessionId: string; fromChannelId: string }): Promise<RaidCancelResult>;
}

export interface RaidArrival {
  eventId: string;
  fromChannelId: string;
  toChannelId: string;
  viewers: number;
  observedAtMs: number;
}
