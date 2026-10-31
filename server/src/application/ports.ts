import type {
  ChatFragment, IllustrativeCountry, LanguageCode, Streamer, TranslationBubble,
} from '@raidsphere/shared';

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

// A chat message normalized by an adapter (Phase 4, module 4). Text is untrusted data.
// sourceLanguage is null when unknown; it is never guessed.
export interface ChatTextMessage {
  messageId: string;
  channelId: string;
  userId: string;
  displayName: string;
  text: string;
  receivedAtMs: number;
  sourceLanguage: LanguageCode | null;
  fragments?: ChatFragment[];
}

// A moderation action from the platform adapter (Phase 4, module 5), never from chat text.
export type ChatModerationAction =
  | { type: 'message_deleted'; channelId: string; messageId: string }
  // A ban or a timeout: the user's earlier messages disappear.
  | { type: 'user_cleared'; channelId: string; userId: string }
  | { type: 'chat_cleared'; channelId: string };

export interface ChatTranslator {
  // Channels are open only while their translation window is active.
  openChannel(channelId: string): void;
  closeChannel(channelId: string): void;
  // Cancels matching work without closing the channel.
  invalidate(action: ChatModerationAction): void;
  // Resolves to null when the message was invalidated or needs no translation.
  translate(message: ChatTextMessage, targetLanguage: LanguageCode): Promise<TranslationBubble | null>;
}
