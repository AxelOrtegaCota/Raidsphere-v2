import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverEventSchema } from '@raidsphere/shared';
import type { LanguageCode, ServerEvent, TranslationBubble, TranslationWindow } from '@raidsphere/shared';
import { ChatTranslationPipeline } from '../src/application/chat-translation.js';
import type { ChatTranslationLimits } from '../src/application/chat-translation.js';
import { openWindow, expireWindow } from '../src/application/translation-window.js';
import type { ChatTextMessage, ChatTranslator } from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { createRuntime } from '../src/composition.js';
import { syntheticStreamers } from '../src/simulation/fixtures.js';
import { SimulatedChat } from '../src/twitch/simulated-chat.js';
import { ManualTime } from './support/fakes.js';

// All identifiers are synthetic fixtures.
const CHANNEL = 'rsdemo_ja_01';
const START = 1_000_000;
const WINDOW_MS = 15 * 60_000;

function completed(message: ChatTextMessage, target: LanguageCode): TranslationBubble {
  return {
    messageId: message.messageId, userId: message.userId, displayName: message.displayName, original: message.text,
    fragments: [{ type: 'text', text: message.text }], fromLanguage: message.sourceLanguage ?? 'en', toLanguage: target,
    illustrativeCountry: null, receivedAtMs: message.receivedAtMs, status: 'completed', translated: `simulated: ${message.text}`,
  };
}

function setup(options: { limits?: Partial<ChatTranslationLimits>; translate?: ChatTranslator['translate'] } = {}) {
  const time = new ManualTime(START);
  const errors: string[] = [];
  const publisher = new EventPublisher({ clock: time, onError: (kind) => { throw new Error(`Publisher error: ${kind}`); } });
  const events: ServerEvent[] = [];
  publisher.subscribe(CHANNEL, (event) => { events.push(event); });
  let window: TranslationWindow | null = openWindow(CHANNEL, 'ja', START, WINDOW_MS);
  const calls: string[] = [];
  const opened: string[] = [];
  const translator: ChatTranslator = {
    openChannel: (channelId) => { opened.push(`open:${channelId}`); },
    closeChannel: (channelId) => { opened.push(`close:${channelId}`); },
    invalidate: () => undefined,
    translate: async (message, target) => {
      calls.push(message.messageId);
      return options.translate ? options.translate(message, target) : completed(message, target);
    },
  };
  const pipeline = new ChatTranslationPipeline({
    clock: time, windows: { translationWindow: async () => window }, translator, publisher,
    onError: (kind) => { errors.push(kind); },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  let messageNumber = 0;
  const message = (overrides: Partial<ChatTextMessage> = {}): ChatTextMessage => {
    messageNumber += 1;
    return {
      messageId: `message-${messageNumber}`, channelId: CHANNEL, userId: 'fixture_user', displayName: 'Fixture User',
      text: 'hello there', receivedAtMs: time.now(), sourceLanguage: 'en', ...overrides,
    };
  };
  const bubbles = () => events.flatMap((event) => (event.type === 'translate:bubble' ? [event.payload] : []));
  const setWindow = (next: TranslationWindow | null) => { window = next; };
  return { time, errors, events, calls, opened, pipeline, message, bubbles, setWindow };
}

describe('chat translation pipeline', () => {
  it('publishes a pending bubble and then the translation', async () => {
    const h = setup();
    await h.pipeline.handleMessage(h.message());
    expect(h.bubbles().map((bubble) => bubble.status)).toEqual(['pending', 'completed']);
    expect(h.bubbles()[0]).toMatchObject({ original: 'hello there', translated: null, fromLanguage: 'en', toLanguage: 'ja' });
    expect(h.bubbles()[1]).toMatchObject({ translated: 'simulated: hello there' });
    for (const event of h.events) expect(serverEventSchema.safeParse(event).success).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('ignores messages without an active window', async () => {
    const h = setup();
    h.setWindow(null);
    await h.pipeline.handleMessage(h.message());
    h.setWindow(expireWindow(openWindow(CHANNEL, 'ja', START, WINDOW_MS)));
    await h.pipeline.handleMessage(h.message());
    h.setWindow(openWindow(CHANNEL, 'ja', START, WINDOW_MS));
    await h.time.advance(WINDOW_MS);
    await h.pipeline.handleMessage(h.message());
    expect(h.events).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('skips commands, messages in the channel language, and repeated deliveries', async () => {
    const h = setup();
    await h.pipeline.handleMessage(h.message({ text: '!vote ja' }));
    await h.pipeline.handleMessage(h.message({ text: '   !cancel' }));
    await h.pipeline.handleMessage(h.message({ sourceLanguage: 'ja' }));
    const repeated = h.message();
    await h.pipeline.handleMessage(repeated);
    await h.pipeline.handleMessage(repeated);
    expect(h.calls).toEqual([repeated.messageId]);
    expect(h.bubbles()).toHaveLength(2);
  });

  it('forwards messages of unknown language instead of guessing one', async () => {
    const h = setup();
    await h.pipeline.handleMessage(h.message({ sourceLanguage: null }));
    expect(h.bubbles()[0]).toMatchObject({ status: 'pending', fromLanguage: null });
    expect(h.calls).toHaveLength(1);
  });

  it('never sends an invalid message to the translator', async () => {
    const time = new ManualTime(START);
    const kinds: string[] = [];
    const publisher = new EventPublisher({ clock: time, onError: (kind) => { kinds.push(kind); } });
    const translate = vi.fn();
    const pipeline = new ChatTranslationPipeline({
      clock: time, windows: { translationWindow: async () => openWindow(CHANNEL, 'ja', START, WINDOW_MS) },
      translator: { openChannel: () => undefined, closeChannel: () => undefined, invalidate: () => undefined, translate },
      publisher, onError: () => undefined,
    });
    await pipeline.handleMessage({
      messageId: 'message-1', channelId: CHANNEL, userId: 'fixture_user', displayName: 'Fixture User',
      text: '', receivedAtMs: START, sourceLanguage: 'en',
    });
    expect(translate).not.toHaveBeenCalled();
    expect(kinds).toEqual(['invalid_event']);
  });

  it('limits each user and each channel, and recovers when the interval passes', async () => {
    const h = setup({ limits: { windowMs: 10_000, perUser: 2, perChannel: 3 } });
    for (let index = 0; index < 4; index += 1) await h.pipeline.handleMessage(h.message());
    expect(h.calls).toHaveLength(2);

    await h.pipeline.handleMessage(h.message({ userId: 'other_user' }));
    await h.pipeline.handleMessage(h.message({ userId: 'third_user' }));
    expect(h.calls).toHaveLength(3);

    await h.time.advance(10_000);
    await h.pipeline.handleMessage(h.message());
    expect(h.calls).toHaveLength(4);
  });

  it('removes the pending bubble when the translation is invalidated', async () => {
    const h = setup({ translate: async () => null });
    const message = h.message();
    await h.pipeline.handleMessage(message);
    expect(h.events.map((event) => event.type)).toEqual(['translate:bubble', 'translate:remove']);
    expect(h.events[1]).toMatchObject({ payload: { messageId: message.messageId } });
  });

  it('reports a translator failure as unavailable, never as translated', async () => {
    const h = setup({ translate: async () => { throw new Error('secret provider detail'); } });
    await h.pipeline.handleMessage(h.message());
    expect(h.bubbles()[1]).toMatchObject({
      status: 'unavailable', reason: 'provider_error', translated: null, original: 'hello there',
    });
    expect(h.errors).toEqual(['translation_failed']);
  });

  it('applies the last check when the window closes during translation', async () => {
    let finish: (bubble: TranslationBubble | null) => void = () => undefined;
    const h = setup({ translate: () => new Promise((resolve) => { finish = resolve; }) });
    const message = h.message();
    const handled = h.pipeline.handleMessage(message);
    await h.time.advance(0);
    expect(h.bubbles().map((bubble) => bubble.status)).toEqual(['pending']);

    h.setWindow(expireWindow(openWindow(CHANNEL, 'ja', START, WINDOW_MS)));
    finish(completed(message, 'ja'));
    await handled;
    expect(h.bubbles().map((bubble) => bubble.status)).toEqual(['pending']);
    expect(h.events.at(-1)).toMatchObject({ type: 'translate:remove', payload: { messageId: message.messageId } });
  });

  it('lets a slow translation finish after a later message', async () => {
    const release = new Map<string, () => void>();
    const h = setup({
      translate: (message, target) => new Promise((resolve) => {
        release.set(message.messageId, () => resolve(completed(message, target)));
      }),
    });
    const first = h.message();
    const second = h.message();
    const handled = [h.pipeline.handleMessage(first), h.pipeline.handleMessage(second)];
    await h.time.advance(0);
    release.get(second.messageId)?.();
    await handled[1];
    release.get(first.messageId)?.();
    await handled[0];
    expect(h.bubbles().map((bubble) => [bubble.messageId, bubble.status])).toEqual([
      [first.messageId, 'pending'], [second.messageId, 'pending'],
      [second.messageId, 'completed'], [first.messageId, 'completed'],
    ]);
  });

  it('opens and closes translation with the window and reports failures without content', () => {
    const h = setup();
    const window = openWindow(CHANNEL, 'ja', START, WINDOW_MS);
    h.pipeline.handleWindow(window);
    h.pipeline.handleWindow(expireWindow(window));
    expect(h.opened).toEqual([`open:${CHANNEL}`, `close:${CHANNEL}`]);

    const errors: string[] = [];
    const failing = new ChatTranslationPipeline({
      clock: h.time, windows: { translationWindow: async () => null },
      translator: {
        openChannel: () => { throw new RangeError('capacity'); }, closeChannel: () => undefined,
        invalidate: () => undefined, translate: async () => null,
      },
      publisher: new EventPublisher({ clock: h.time, onError: () => undefined }), onError: (kind) => { errors.push(kind); },
    });
    failing.handleWindow(window);
    expect(errors).toEqual(['window_failed']);
  });

  it('publishes nothing after close', async () => {
    let finish: (bubble: TranslationBubble | null) => void = () => undefined;
    const h = setup({ translate: () => new Promise((resolve) => { finish = resolve; }) });
    const message = h.message();
    const handled = h.pipeline.handleMessage(message);
    await h.time.advance(0);
    h.pipeline.close();
    finish(completed(message, 'ja'));
    await handled;
    await h.pipeline.handleMessage(h.message());
    expect(h.bubbles().map((bubble) => bubble.status)).toEqual(['pending']);
    expect(h.events).toHaveLength(1);
  });
});

describe('chat translation in the composed runtime', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('translates raider chat through the real service only while the window is open', async () => {
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
    const raiders = new SimulatedChat(runtime.coordinator, CHANNEL, runtime.chatMessages);

    // Before the arrival no window exists, so nothing is translated.
    await raiders.say({ userId: 'early_raider', language: 'en' }, 'hello');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events.filter((event) => event.type === 'translate:bubble')).toEqual([]);
    expect(events.find((event) => event.type === 'translation:window')).toMatchObject({
      channelId: CHANNEL, payload: { status: 'active', targetLanguage: 'ja' },
    });

    // The simulated provider answers on a timer, so the clock moves before the reply settles.
    const said = raiders.say({ userId: 'raider_01', language: 'en' }, 'thanks for the raid');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(said).resolves.toBe(true);
    const bubbles = events.flatMap((event) => (event.type === 'translate:bubble' ? [event.payload] : []));
    expect(bubbles.map((bubble) => bubble.status)).toEqual(['pending', 'completed']);
    expect(bubbles[1]).toMatchObject({ translated: 'レイドありがとう', fromLanguage: 'en', toLanguage: 'ja' });

    // After the window expires, chat is ignored again.
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(events.filter((event) => event.type === 'translation:window').at(-1)).toMatchObject({ payload: { status: 'expired' } });
    const before = events.length;
    await raiders.say({ userId: 'late_raider', language: 'en' }, 'hello again');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveLength(before);
    expect(errors).toEqual([]);

    for (const view of views) view?.close();
    vi.useRealTimers();
    await runtime.app.close();
  });
});
