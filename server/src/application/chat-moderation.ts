import type { ChatModerationAction, ChatTextMessage } from './ports.js';

// Moderation memory (Phase 4, module 5). An action can arrive before its message or while a
// translation is running, so what was moderated is remembered instead of only acted on once.
// Timestamps use the server clock, the same one that stamps received messages.

const MEMORY_LIMIT = 1_000;

interface ChannelModeration {
  removedMessages: Set<string>;
  clearedUsers: Map<string, number>;
  clearedAtMs: number | null;
}

export class ChatModerationMemory {
  readonly #channels = new Map<string, ChannelModeration>();

  record(action: ChatModerationAction, nowMs: number): void {
    const channel = this.#channel(action.channelId);
    switch (action.type) {
      case 'message_deleted':
        channel.removedMessages.add(action.messageId);
        trimOldest(channel.removedMessages);
        return;
      case 'user_cleared':
        // Re-inserting keeps the most recent action last, so trimming drops the oldest.
        channel.clearedUsers.delete(action.userId);
        channel.clearedUsers.set(action.userId, nowMs);
        trimOldest(channel.clearedUsers);
        return;
      case 'chat_cleared':
        channel.clearedAtMs = nowMs;
    }
  }

  // Later messages from a cleared user are allowed: a timeout ends, and a ban stops them at Twitch.
  blocks(message: ChatTextMessage): boolean {
    const channel = this.#channels.get(message.channelId);
    if (!channel) return false;
    if (channel.removedMessages.has(message.messageId)) return true;
    if (channel.clearedAtMs !== null && message.receivedAtMs <= channel.clearedAtMs) return true;
    const clearedAtMs = channel.clearedUsers.get(message.userId);
    return clearedAtMs !== undefined && message.receivedAtMs <= clearedAtMs;
  }

  clear(): void {
    this.#channels.clear();
  }

  #channel(channelId: string): ChannelModeration {
    const existing = this.#channels.get(channelId);
    if (existing) return existing;
    const created: ChannelModeration = { removedMessages: new Set(), clearedUsers: new Map(), clearedAtMs: null };
    this.#channels.set(channelId, created);
    return created;
  }
}

function trimOldest(entries: Set<string> | Map<string, number>): void {
  if (entries.size <= MEMORY_LIMIT) return;
  const oldest = entries.keys().next().value;
  if (oldest !== undefined) entries.delete(oldest);
}
