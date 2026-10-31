/**
 * Module B: adapters from validated EventSub events to the Module D application ports.
 * Roles come from Twitch badges, never from message text.
 */
import type { ChatFragment } from '@raidsphere/shared';
import type { ChatModerationAction, RaidArrival } from '../application/ports.js';
import type { ChatMessage } from './commands.js';
import type { ChannelChatMessageEvent, EventSubNotification, RaidEvent } from './eventsub.js';

const MODERATOR_BADGES: ReadonlySet<string> = new Set(['moderator', 'lead_moderator']);
const MAX_PUBLIC_FRAGMENTS = 100;

export function toChatMessage(event: ChannelChatMessageEvent, receivedAtMs: number): ChatMessage {
  return {
    messageId: event.message_id, userId: event.chatter_user_id, userLogin: event.chatter_user_login,
    channelId: event.broadcaster_user_id, text: event.message.text, timestamp: receivedAtMs,
    badges: event.badges.map((badge) => badge.set_id),
    isBroadcaster: event.badges.some((badge) => badge.set_id === 'broadcaster'),
    isModerator: event.badges.some((badge) => MODERATOR_BADGES.has(badge.set_id)),
  };
}

type EventFragment = ChannelChatMessageEvent['message']['fragments'][number];

function toChatFragment(fragment: EventFragment): ChatFragment {
  if (fragment.type === 'emote' && fragment.emote) {
    return { type: 'emote', text: fragment.text, emoteId: fragment.emote.id };
  }
  if (fragment.type === 'mention' && fragment.mention) {
    return { type: 'mention', text: fragment.text, userId: fragment.mention.user_id };
  }
  return { type: 'text', text: fragment.text };
}

/** Undefined when the public contract cannot carry the list; the text alone still works. */
export function toChatFragments(event: ChannelChatMessageEvent): ChatFragment[] | undefined {
  const { fragments } = event.message;
  if (fragments.length === 0 || fragments.length > MAX_PUBLIC_FRAGMENTS) return undefined;
  return fragments.map(toChatFragment);
}

/** Shared chat delivers messages from other channels, and those viewers have no say here. */
export function isFromAnotherChannel(event: ChannelChatMessageEvent): boolean {
  const source = event.source_broadcaster_user_id;
  return typeof source === 'string' && source !== event.broadcaster_user_id;
}

export function toModerationAction(notification: EventSubNotification): ChatModerationAction | null {
  switch (notification.type) {
    case 'channel.chat.message_delete':
      return {
        type: 'message_deleted', channelId: notification.event.broadcaster_user_id, messageId: notification.event.message_id,
      };
    case 'channel.chat.clear_user_messages':
      return {
        type: 'user_cleared', channelId: notification.event.broadcaster_user_id, userId: notification.event.target_user_id,
      };
    case 'channel.chat.clear':
      return { type: 'chat_cleared', channelId: notification.event.broadcaster_user_id };
    default:
      return null;
  }
}

export function toRaidArrival(eventId: string, event: RaidEvent, observedAtMs: number): RaidArrival {
  return {
    eventId, fromChannelId: event.from_broadcaster_user_id, toChannelId: event.to_broadcaster_user_id,
    viewers: event.viewers, observedAtMs,
  };
}
