/**
 * Module C: adapter from the translation service to the Module D chat translator port.
 * Each open channel holds one service session, so closing a window invalidates its work.
 */
import { randomUUID } from 'node:crypto';
import type { LanguageCode, TranslationBubble } from '@raidsphere/shared';
import type { ChatModerationAction, ChatTextMessage, ChatTranslator } from '../application/ports.js';
import { fragmentMessage } from './emotes.js';
import type { LanguageDetector, TranslationProvider } from './provider.js';
import {
  activateTranslationSession, invalidateTranslationMessage, invalidateTranslationSession,
  invalidateTranslationUser, translateMessage,
} from './service.js';
import type { TranslationSession } from './service.js';

export interface ServiceChatTranslatorOptions {
  provider: TranslationProvider;
  // Detects the language of messages that arrive without one, such as real Twitch chat.
  detector?: LanguageDetector;
  // Explicit opt-in: simulated output is never produced by default.
  simulationMode: boolean;
}

export class ServiceChatTranslator implements ChatTranslator {
  private readonly options: ServiceChatTranslatorOptions;
  private readonly sessions = new Map<string, TranslationSession>();

  constructor(options: ServiceChatTranslatorOptions) {
    this.options = options;
  }

  openChannel(channelId: string): void {
    // A new session revokes the previous one and invalidates its pending work.
    this.sessions.set(channelId, activateTranslationSession(channelId, randomUUID()));
  }

  closeChannel(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    this.sessions.delete(channelId);
    invalidateTranslationSession(channelId, session.sessionId);
  }

  invalidate(action: ChatModerationAction): void {
    switch (action.type) {
      case 'message_deleted':
        invalidateTranslationMessage(action.channelId, action.messageId);
        return;
      case 'user_cleared':
        invalidateTranslationUser(action.channelId, action.userId);
        return;
      case 'chat_cleared':
        // A new session cancels all work and purges the cache while the window stays open.
        if (this.sessions.has(action.channelId)) this.openChannel(action.channelId);
    }
  }

  async translate(message: ChatTextMessage, targetLanguage: LanguageCode): Promise<TranslationBubble | null> {
    const session = this.sessions.get(message.channelId);
    if (!session) return null;
    let sourceLanguage = message.sourceLanguage;
    if (sourceLanguage === null && this.options.detector) {
      const text = detectableText(message);
      // Only emotes, mentions, links, or symbols: there is nothing to translate.
      if (!/\p{L}/u.test(text)) return null;
      sourceLanguage = await this.options.detector.detect(text);
      if (sourceLanguage === targetLanguage) return null;
    }
    return translateMessage({
      channelId: message.channelId, receivedAtMs: message.receivedAtMs, messageId: message.messageId,
      userId: message.userId, displayName: message.displayName, text: message.text,
      sourceLanguage, targetLanguage, simulationMode: this.options.simulationMode,
      ...(message.fragments ? { fragments: message.fragments } : {}),
    }, this.options.provider, { session });
  }

  close(): void {
    for (const channelId of [...this.sessions.keys()]) this.closeChannel(channelId);
  }
}

// Emotes, mentions, links, and emoji would skew detection, so only plain text is sent.
function detectableText(message: ChatTextMessage): string {
  return fragmentMessage(message.text, [], message.fragments).fragments
    .filter((fragment) => fragment.type === 'text').map((fragment) => fragment.value).join('').trim();
}
