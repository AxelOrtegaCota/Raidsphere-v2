import { describe, expect, it } from 'vitest';
import { commandRole, toChatCommand, toChatTextMessage } from '../src/twitch/adapters.js';
import {
  isFromAnotherChannel, toChatFragments, toChatMessage, toModerationAction, toRaidArrival,
} from '../src/twitch/eventsub-adapters.js';
import type { ChannelChatMessageEvent, EventSubNotification } from '../src/twitch/eventsub.js';

// All values are test fixtures.
const broadcaster = { broadcaster_user_id: '1001', broadcaster_user_login: 'origin', broadcaster_user_name: 'Origin' };
const target = { target_user_id: '3003', target_user_login: 'viewer', target_user_name: 'Viewer' };

const chatEvent = (overrides: Partial<ChannelChatMessageEvent> = {}): ChannelChatMessageEvent => ({
  ...broadcaster,
  chatter_user_id: '3003', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
  message_id: 'chat-1', message: { text: 'hola', fragments: [{ type: 'text', text: 'hola' }] },
  color: '', badges: [],
  ...overrides,
});

describe('EventSub chat adapters', () => {
  it('normalizes a chat event without trusting the message text for roles', () => {
    const message = toChatMessage(chatEvent({ message: { text: '!roulette broadcaster', fragments: [] } }), 1_000);
    expect(message).toMatchObject({
      messageId: 'chat-1', userId: '3003', userLogin: 'viewer', channelId: '1001',
      text: '!roulette broadcaster', timestamp: 1_000, isBroadcaster: false, isModerator: false,
    });
    expect(commandRole(message)).toBe('viewer');
  });

  it('takes roles from Twitch badges', () => {
    const owner = toChatMessage(chatEvent({
      chatter_user_id: '1001', badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
    }), 1_000);
    const moderator = toChatMessage(chatEvent({ badges: [{ set_id: 'moderator', id: '1', info: '' }] }), 1_000);
    const leadModerator = toChatMessage(chatEvent({ badges: [{ set_id: 'lead_moderator', id: '1', info: '' }] }), 1_000);
    expect(commandRole(owner)).toBe('broadcaster');
    expect(commandRole(moderator)).toBe('moderator');
    expect(commandRole(leadModerator)).toBe('moderator');
  });

  it('does not grant the broadcaster role to another user with a forged badge', () => {
    const forged = toChatMessage(chatEvent({ badges: [{ set_id: 'broadcaster', id: '1', info: '' }] }), 1_000);
    expect(commandRole(forged)).toBe('viewer');
  });

  it('reaches the command port for votes', () => {
    const message = toChatMessage(chatEvent({ message: { text: '!vote es', fragments: [] } }), 1_000);
    expect(toChatCommand(message)).toEqual({
      messageId: 'chat-1', channelId: '1001', userId: '3003', role: 'viewer',
      command: { type: 'vote', language: 'es' },
    });
  });

  it('maps fragments and keeps the source language unknown', () => {
    const event = chatEvent({
      message: {
        text: 'hi Kappa @friend 10',
        fragments: [
          { type: 'text', text: 'hi ' },
          { type: 'emote', text: 'Kappa', emote: { id: '25', emote_set_id: '0' } },
          { type: 'mention', text: '@friend', mention: { user_id: '4004', user_login: 'friend', user_name: 'Friend' } },
          { type: 'cheermote', text: ' 10', cheermote: { prefix: 'cheer', bits: 10 } },
        ],
      },
    });
    const fragments = toChatFragments(event);
    expect(fragments).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'emote', text: 'Kappa', emoteId: '25' },
      { type: 'mention', text: '@friend', userId: '4004' },
      { type: 'text', text: ' 10' },
    ]);
    const text = toChatTextMessage(toChatMessage(event, 1_000), {
      displayName: event.chatter_user_name, sourceLanguage: null, ...(fragments ? { fragments } : {}),
    });
    expect(text).toMatchObject({ sourceLanguage: null, displayName: 'Viewer', fragments });
  });

  it('leaves out fragment lists the public contract cannot carry', () => {
    const many = Array.from({ length: 101 }, () => ({ type: 'text', text: 'a' }));
    expect(toChatFragments(chatEvent({ message: { text: 'a', fragments: many } }))).toBeUndefined();
    expect(toChatFragments(chatEvent({ message: { text: 'a', fragments: [] } }))).toBeUndefined();
  });

  it('recognizes messages shared from another channel', () => {
    expect(isFromAnotherChannel(chatEvent())).toBe(false);
    expect(isFromAnotherChannel(chatEvent({ source_broadcaster_user_id: '1001' }))).toBe(false);
    expect(isFromAnotherChannel(chatEvent({ source_broadcaster_user_id: '9009' }))).toBe(true);
  });
});

describe('EventSub event adapters', () => {
  const notification = <T extends EventSubNotification>(item: Omit<T, 'eventId' | 'receivedAtMs'>): T =>
    ({ ...item, eventId: 'event-1', receivedAtMs: 2_000 }) as T;

  it('maps moderation events to the moderation port', () => {
    expect(toModerationAction(notification({
      type: 'channel.chat.message_delete', event: { ...broadcaster, ...target, message_id: 'chat-1' },
    }))).toEqual({ type: 'message_deleted', channelId: '1001', messageId: 'chat-1' });
    expect(toModerationAction(notification({
      type: 'channel.chat.clear_user_messages', event: { ...broadcaster, ...target },
    }))).toEqual({ type: 'user_cleared', channelId: '1001', userId: '3003' });
    expect(toModerationAction(notification({
      type: 'channel.chat.clear', event: broadcaster,
    }))).toEqual({ type: 'chat_cleared', channelId: '1001' });
  });

  it('does not treat other events as moderation', () => {
    expect(toModerationAction(notification({ type: 'channel.chat.message', event: chatEvent() }))).toBeNull();
  });

  it('maps a raid event to an arrival identified by its delivery', () => {
    expect(toRaidArrival('event-1', {
      from_broadcaster_user_id: '1001', from_broadcaster_user_login: 'origin', from_broadcaster_user_name: 'Origin',
      to_broadcaster_user_id: '2002', to_broadcaster_user_login: 'target', to_broadcaster_user_name: 'Target',
      viewers: 42,
    }, 2_000)).toEqual({
      eventId: 'event-1', fromChannelId: '1001', toChannelId: '2002', viewers: 42, observedAtMs: 2_000,
    });
  });
});
