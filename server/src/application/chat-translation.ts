import type { TranslationBubble, TranslationWindow } from '@raidsphere/shared';
import { ChatModerationMemory } from './chat-moderation.js';
import type { ChatModerationAction, ChatTextMessage, ChatTranslator, Clock } from './ports.js';
import type { EventPublisher, ServerEventDraft } from './publisher.js';
import { isWindowActive } from './translation-window.js';

// From chat message to translation bubble (Phase 4, module 4). Chat text is untrusted data:
// it is only forwarded to the translator and published through validated events. Translation
// runs outside the channel queue, so a slow provider never delays roulette work.

export interface ChatTranslationLimits {
  windowMs: number;
  perUser: number;
  perChannel: number;
}

export const DEFAULT_CHAT_TRANSLATION_LIMITS: ChatTranslationLimits = { windowMs: 10_000, perUser: 5, perChannel: 30 };

export interface ChatTranslationDependencies {
  clock: Clock;
  windows: { translationWindow(channelId: string): Promise<TranslationWindow | null> };
  translator: ChatTranslator;
  publisher: EventPublisher;
  // Reports carry no content, so chat data never reaches logs.
  onError: (kind: 'translation_failed' | 'window_failed' | 'moderation_failed') => void;
  limits?: Partial<ChatTranslationLimits>;
}

const SEEN_LIMIT = 1_000;
const TRACKED_RATE_KEYS = 2_000;

export class ChatTranslationPipeline {
  readonly #deps: ChatTranslationDependencies;
  readonly #limits: ChatTranslationLimits;
  readonly #seenMessages = new Map<string, Set<string>>();
  readonly #recentByKey = new Map<string, number[]>();
  readonly #moderation = new ChatModerationMemory();
  #closed = false;

  constructor(dependencies: ChatTranslationDependencies) {
    this.#deps = dependencies;
    this.#limits = { ...DEFAULT_CHAT_TRANSLATION_LIMITS, ...dependencies.limits };
  }

  async handleMessage(message: ChatTextMessage): Promise<void> {
    const { clock, windows, publisher, translator, onError } = this.#deps;
    if (this.#closed || !this.#firstDelivery(message)) return;
    const window = await windows.translationWindow(message.channelId);
    if (!window || !isWindowActive(window, clock.now()) || this.#moderation.blocks(message)) return;
    if (message.text.trimStart().startsWith('!') || message.sourceLanguage === window.targetLanguage) return;
    if (!this.#withinLimits(message, clock.now())) return;

    const pending = pendingBubble(message, window);
    // An invalid message stops here: nothing untrusted reaches the provider unvalidated.
    if (!publisher.publish({ type: 'translate:bubble', channelId: message.channelId, payload: pending })) return;

    let bubble: TranslationBubble | null;
    try {
      bubble = await translator.translate(message, window.targetLanguage);
    } catch {
      onError('translation_failed');
      bubble = { ...pending, status: 'unavailable', translated: null, reason: 'provider_error' };
    }
    if (this.#closed) return;

    // Last check before publishing: nothing asynchronous separates it from the publish.
    const current = await windows.translationWindow(message.channelId);
    if (this.#closed) return;
    if (!bubble || !isWindowActive(current, clock.now()) || this.#moderation.blocks(message)) {
      publisher.publish({ type: 'translate:remove', channelId: message.channelId, payload: { messageId: message.messageId } });
      return;
    }
    publisher.publish({ type: 'translate:bubble', channelId: message.channelId, payload: bubble });
  }

  // Moderation applies at once: memory and invalidation happen before anything asynchronous,
  // so a running translation can no longer be published.
  async handleModeration(action: ChatModerationAction): Promise<void> {
    const { clock, windows, translator, publisher, onError } = this.#deps;
    if (this.#closed) return;
    this.#moderation.record(action, clock.now());
    try {
      translator.invalidate(action);
    } catch {
      onError('moderation_failed');
    }
    const window = await windows.translationWindow(action.channelId);
    if (this.#closed || !isWindowActive(window, clock.now())) return;
    publisher.publish(moderationEvent(action));
  }

  // Follows the coordinator's window: translation runs only while a window is active.
  handleWindow(window: TranslationWindow): void {
    const { translator, onError } = this.#deps;
    try {
      if (window.status === 'active') translator.openChannel(window.channelId);
      else translator.closeChannel(window.channelId);
    } catch {
      onError('window_failed');
    }
  }

  close(): void {
    this.#closed = true;
    this.#seenMessages.clear();
    this.#recentByKey.clear();
    this.#moderation.clear();
  }

  #firstDelivery(message: ChatTextMessage): boolean {
    const seen = this.#seenMessages.get(message.channelId) ?? new Set<string>();
    this.#seenMessages.set(message.channelId, seen);
    if (seen.has(message.messageId)) return false;
    seen.add(message.messageId);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  // Sliding windows. Messages over a limit are dropped, not queued, so a flood cannot build a backlog.
  #withinLimits(message: ChatTextMessage, nowMs: number): boolean {
    const { windowMs, perUser, perChannel } = this.#limits;
    const userKey = `user:${message.channelId}:${message.userId}`;
    const channelKey = `channel:${message.channelId}`;
    const recentUser = this.#recent(userKey, nowMs, windowMs);
    const recentChannel = this.#recent(channelKey, nowMs, windowMs);
    if (recentUser.length >= perUser || recentChannel.length >= perChannel) return false;
    this.#remember(userKey, [...recentUser, nowMs]);
    this.#remember(channelKey, [...recentChannel, nowMs]);
    return true;
  }

  #recent(key: string, nowMs: number, windowMs: number): number[] {
    return (this.#recentByKey.get(key) ?? []).filter((atMs) => nowMs - atMs < windowMs);
  }

  #remember(key: string, times: number[]): void {
    this.#recentByKey.delete(key);
    this.#recentByKey.set(key, times);
    if (this.#recentByKey.size > TRACKED_RATE_KEYS) {
      const oldest = this.#recentByKey.keys().next().value;
      if (oldest !== undefined) this.#recentByKey.delete(oldest);
    }
  }
}

function moderationEvent(action: ChatModerationAction): ServerEventDraft {
  const { channelId } = action;
  switch (action.type) {
    case 'message_deleted':
      return { type: 'translate:remove', channelId, payload: { messageId: action.messageId } };
    case 'user_cleared':
      return { type: 'translate:clear', channelId, payload: { scope: 'user', userId: action.userId } };
    case 'chat_cleared':
      return { type: 'translate:clear', channelId, payload: { scope: 'channel' } };
  }
}

function pendingBubble(message: ChatTextMessage, window: TranslationWindow): Extract<TranslationBubble, { status: 'pending' }> {
  return {
    messageId: message.messageId, userId: message.userId, displayName: message.displayName,
    original: message.text, fragments: message.fragments ?? [{ type: 'text', text: message.text }],
    fromLanguage: message.sourceLanguage, toLanguage: window.targetLanguage,
    illustrativeCountry: null, receivedAtMs: message.receivedAtMs, status: 'pending', translated: null,
  };
}
