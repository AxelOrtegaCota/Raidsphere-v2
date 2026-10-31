import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, TranslationBubble, TranslationWindow } from '@raidsphere/shared';
import { ChatModerationMemory } from '../src/application/chat-moderation.js';
import { ChatTranslationPipeline } from '../src/application/chat-translation.js';
import { openWindow } from '../src/application/translation-window.js';
import type { ChatModerationAction, ChatTextMessage, ChatTranslator } from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { createRuntime } from '../src/composition.js';
import { syntheticStreamers } from '../src/simulation/fixtures.js';
import { SimulatedChat } from '../src/twitch/simulated-chat.js';
import { ManualTime } from './support/fakes.js';

// All identifiers are synthetic fixtures.
const CHANNEL = 'rsdemo_ja_01';
const OTHER = 'rsdemo_pt_01';
const START = 1_000_000;
const WINDOW_MS = 15 * 60_000;

function textMessage(overrides: Partial<ChatTextMessage> = {}): ChatTextMessage {
  return {
    messageId: 'message-1', channelId: CHANNEL, userId: 'fixture_user', displayName: 'Fixture User',
    text: 'hello there', receivedAtMs: START, sourceLanguage: 'en', ...overrides,
  };
}

function completed(message: ChatTextMessage): TranslationBubble {
  return {
    messageId: message.messageId, userId: message.userId, displayName: message.displayName, original: message.text,
    fragments: [{ type: 'text', text: message.text }], fromLanguage: 'en', toLanguage: 'ja',
    illustrativeCountry: null, receivedAtMs: message.receivedAtMs, status: 'completed', translated: 'simulated',
  };
}

describe('chat moderation memory', () => {
  it('blocks a deleted message only', () => {
    const memory = new ChatModerationMemory();
    memory.record({ type: 'message_deleted', channelId: CHANNEL, messageId: 'message-1' }, START);
    expect(memory.blocks(textMessage())).toBe(true);
    expect(memory.blocks(textMessage({ messageId: 'message-2' }))).toBe(false);
  });

  it('blocks a cleared user up to the action and allows later messages', () => {
    const memory = new ChatModerationMemory();
    memory.record({ type: 'user_cleared', channelId: CHANNEL, userId: 'fixture_user' }, START);
    expect(memory.blocks(textMessage({ receivedAtMs: START }))).toBe(true);
    expect(memory.blocks(textMessage({ receivedAtMs: START + 1 }))).toBe(false);
    expect(memory.blocks(textMessage({ userId: 'other_user' }))).toBe(false);
  });

  it('blocks everyone up to a chat clear', () => {
    const memory = new ChatModerationMemory();
    memory.record({ type: 'chat_cleared', channelId: CHANNEL }, START);
    expect(memory.blocks(textMessage({ userId: 'other_user', receivedAtMs: START }))).toBe(true);
    expect(memory.blocks(textMessage({ receivedAtMs: START + 1 }))).toBe(false);
  });

  it('keeps channels apart', () => {
    const memory = new ChatModerationMemory();
    memory.record({ type: 'chat_cleared', channelId: OTHER }, START);
    memory.record({ type: 'message_deleted', channelId: OTHER, messageId: 'message-1' }, START);
    expect(memory.blocks(textMessage())).toBe(false);
  });

  it('stays bounded, forgetting the oldest entries', () => {
    const memory = new ChatModerationMemory();
    for (let index = 0; index <= 1_000; index += 1) {
      memory.record({ type: 'message_deleted', channelId: CHANNEL, messageId: `message-${index}` }, START);
    }
    expect(memory.blocks(textMessage({ messageId: 'message-0' }))).toBe(false);
    expect(memory.blocks(textMessage({ messageId: 'message-1000' }))).toBe(true);
  });
});

function setup(options: { translate?: ChatTranslator['translate']; invalidate?: ChatTranslator['invalidate'] } = {}) {
  const time = new ManualTime(START);
  const errors: string[] = [];
  const publisher = new EventPublisher({ clock: time, onError: (kind) => { throw new Error(`Publisher error: ${kind}`); } });
  const events: ServerEvent[] = [];
  publisher.subscribe(CHANNEL, (event) => { events.push(event); });
  let window: TranslationWindow | null = openWindow(CHANNEL, 'ja', START, WINDOW_MS);
  const invalidated: ChatModerationAction[] = [];
  const pipeline = new ChatTranslationPipeline({
    clock: time, windows: { translationWindow: async () => window },
    translator: {
      openChannel: () => undefined, closeChannel: () => undefined,
      invalidate: options.invalidate ?? ((action) => { invalidated.push(action); }),
      translate: options.translate ?? (async (message) => completed(message)),
    },
    publisher, onError: (kind) => { errors.push(kind); },
  });
  const statuses = () => events.flatMap((event) => (event.type === 'translate:bubble' ? [event.payload.status] : []));
  return { time, errors, events, invalidated, pipeline, statuses, setWindow: (next: TranslationWindow | null) => { window = next; } };
}

describe('moderation in the chat pipeline', () => {
  it('removes a deleted message from the overlay and cancels its translation', async () => {
    const h = setup();
    const action: ChatModerationAction = { type: 'message_deleted', channelId: CHANNEL, messageId: 'message-1' };
    await h.pipeline.handleMessage(textMessage());
    await h.pipeline.handleModeration(action);
    expect(h.invalidated).toEqual([action]);
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:remove', payload: { messageId: 'message-1' } });
  });

  it('never publishes a translation deleted while it was running, even if the provider answers', async () => {
    let finish: (bubble: TranslationBubble | null) => void = () => undefined;
    const h = setup({ translate: () => new Promise((resolve) => { finish = resolve; }) });
    const message = textMessage();
    const handled = h.pipeline.handleMessage(message);
    await h.time.advance(0);
    await h.pipeline.handleModeration({ type: 'message_deleted', channelId: CHANNEL, messageId: message.messageId });
    finish(completed(message));
    await handled;
    expect(h.statuses()).toEqual(['pending']);
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:remove' });
  });

  it('never shows a message whose deletion arrived first', async () => {
    const translate = vi.fn(async (message: ChatTextMessage) => completed(message));
    const h = setup({ translate });
    await h.pipeline.handleModeration({ type: 'message_deleted', channelId: CHANNEL, messageId: 'message-1' });
    await h.pipeline.handleMessage(textMessage());
    expect(translate).not.toHaveBeenCalled();
    expect(h.statuses()).toEqual([]);
  });

  it('stops a message that was already past the window check when moderation arrives', async () => {
    const translate = vi.fn(async (message: ChatTextMessage) => completed(message));
    const h = setup({ translate });
    const handled = h.pipeline.handleMessage(textMessage());
    const moderated = h.pipeline.handleModeration({ type: 'user_cleared', channelId: CHANNEL, userId: 'fixture_user' });
    await Promise.all([handled, moderated]);
    expect(translate).not.toHaveBeenCalled();
    expect(h.statuses()).toEqual([]);
  });

  it('clears a timed-out user, blocks their earlier messages, and allows later ones', async () => {
    const h = setup();
    await h.pipeline.handleMessage(textMessage());
    await h.time.advance(1_000);
    await h.pipeline.handleModeration({ type: 'user_cleared', channelId: CHANNEL, userId: 'fixture_user' });
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:clear', payload: { scope: 'user', userId: 'fixture_user' } });

    const before = h.statuses().length;
    await h.pipeline.handleMessage(textMessage({ messageId: 'message-2', receivedAtMs: START + 500 }));
    expect(h.statuses()).toHaveLength(before);
    await h.time.advance(1_000);
    await h.pipeline.handleMessage(textMessage({ messageId: 'message-3', receivedAtMs: h.time.now() }));
    expect(h.statuses()).toHaveLength(before + 2);
  });

  it('clears the chat and keeps translating later messages', async () => {
    const h = setup();
    await h.pipeline.handleModeration({ type: 'chat_cleared', channelId: CHANNEL });
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:clear', payload: { scope: 'channel' } });
    await h.time.advance(1);
    await h.pipeline.handleMessage(textMessage({ receivedAtMs: h.time.now() }));
    expect(h.statuses()).toEqual(['pending', 'completed']);
  });

  it('remembers moderation without a window but publishes nothing', async () => {
    const translate = vi.fn(async (message: ChatTextMessage) => completed(message));
    const h = setup({ translate });
    h.setWindow(null);
    await h.pipeline.handleModeration({ type: 'message_deleted', channelId: CHANNEL, messageId: 'message-1' });
    expect(h.events).toEqual([]);
    expect(h.invalidated).toHaveLength(1);
    h.setWindow(openWindow(CHANNEL, 'ja', START, WINDOW_MS));
    await h.pipeline.handleMessage(textMessage());
    expect(translate).not.toHaveBeenCalled();
  });

  it('still hides the message when the translator cannot invalidate', async () => {
    const h = setup({ invalidate: () => { throw new Error('secret detail'); } });
    await h.pipeline.handleModeration({ type: 'message_deleted', channelId: CHANNEL, messageId: 'message-1' });
    expect(h.errors).toEqual(['moderation_failed']);
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:remove' });
  });

  it('does nothing after close', async () => {
    const h = setup();
    h.pipeline.close();
    await h.pipeline.handleModeration({ type: 'chat_cleared', channelId: CHANNEL });
    expect(h.invalidated).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe('moderation in the composed runtime', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cancels running translations in the real service and keeps the window open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    const errors: string[] = [];
    const runtime = createRuntime({
      reportError: (message) => { errors.push(message); },
      simulatedRaid: {
        acceptRate: 1, arrivalRate: 1, minCountdownMs: 10_000, maxCountdownMs: 10_000, observationTimeoutMs: 20_000,
      },
    });
    const events: ServerEvent[] = [];
    const views = await Promise.all(syntheticStreamers.map((streamer) =>
      runtime.coordinator.openView(streamer.id, (event) => { events.push(event); })));
    const source = new SimulatedChat(runtime.coordinator, 'rsdemo_es_01');
    await source.say(source.broadcaster, '!roulette');
    await source.say({ userId: 'fixture_voter' }, '!vote ja');
    await vi.advanceTimersByTimeAsync(40_000);
    const raiders = new SimulatedChat(runtime.coordinator, CHANNEL, runtime.chatMessages);
    const bubbles = () => events.flatMap((event) => (event.type === 'translate:bubble' ? [event.payload] : []));

    // Deleted while the simulated provider is still working.
    const deleted = raiders.say({ userId: 'raider_01', language: 'en' }, 'hello');
    const deletedId = raiders.lastMessageId;
    await vi.advanceTimersByTimeAsync(10);
    await raiders.deleteMessage(deletedId);
    await vi.advanceTimersByTimeAsync(1_000);
    await deleted;
    expect(bubbles().filter((bubble) => bubble.messageId === deletedId).map((bubble) => bubble.status)).toEqual(['pending']);
    expect(events.filter((event) => event.type === 'translate:remove').length).toBeGreaterThan(0);

    // A chat clear cancels running work, and the same window keeps translating afterwards.
    const cleared = raiders.say({ userId: 'raider_02', language: 'en' }, 'good game');
    const clearedId = raiders.lastMessageId;
    await vi.advanceTimersByTimeAsync(10);
    await raiders.clearChat();
    await vi.advanceTimersByTimeAsync(1_000);
    await cleared;
    expect(bubbles().filter((bubble) => bubble.messageId === clearedId).map((bubble) => bubble.status)).toEqual(['pending']);
    expect(events.find((event) => event.type === 'translate:clear')).toMatchObject({ payload: { scope: 'channel' } });

    const after = raiders.say({ userId: 'raider_03', language: 'en' }, 'nice stream');
    const afterId = raiders.lastMessageId;
    await vi.advanceTimersByTimeAsync(1_000);
    await after;
    expect(bubbles().filter((bubble) => bubble.messageId === afterId).map((bubble) => bubble.status)).toEqual(['pending', 'completed']);
    expect(errors).toEqual([]);

    for (const view of views) view?.close();
    vi.useRealTimers();
    await runtime.app.close();
  });
});
