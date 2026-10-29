import { describe, expect, it } from 'vitest';
import { serverEventSchema } from '@raidsphere/shared';
import type { LanguageCode, ServerEvent, TranslationWindow } from '@raidsphere/shared';
import type { RaidCancelResult, RaidRequestResult } from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { RouletteCoordinator } from '../src/application/roulette.js';
import type { RouletteConfig } from '../src/application/roulette.js';
import {
  TRANSLATION_WINDOW_MS, effectiveWindow, expireWindow, isWindowActive, openWindow,
} from '../src/application/translation-window.js';
import {
  InMemoryRouletteRepository, InMemoryStreamerRepository, InMemoryTranslationWindowRepository,
} from '../src/persistence/memory.js';
import { syntheticLiveChannels, syntheticStreamers } from '../src/simulation/fixtures.js';
import { ManualTime, ScriptedRandom } from './support/fakes.js';

// All identifiers are synthetic fixtures. Voting for ja selects rsdemo_ja_01 from the demo source.
const SOURCE = 'rsdemo_es_01';
const DESTINATION = 'rsdemo_ja_01';
const START = 1_000_000;
const VOTING_MS = 30_000;
const WINDOW_MS = TRANSLATION_WINDOW_MS;

describe('translation window rules', () => {
  it('opens an active window for the full duration', () => {
    expect(openWindow(DESTINATION, 'ja', START, WINDOW_MS)).toEqual({
      channelId: DESTINATION, status: 'active', targetLanguage: 'ja', activatedAtMs: START, expiresAtMs: START + WINDOW_MS,
    });
    expect(WINDOW_MS).toBe(900_000);
  });

  it('rejects durations that are not positive whole milliseconds', () => {
    for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => openWindow(DESTINATION, 'ja', START, duration)).toThrow();
    }
  });

  it('reports a window as expired from its deadline onwards without mutating it', () => {
    const window = openWindow(DESTINATION, 'ja', START, WINDOW_MS);
    expect(isWindowActive(window, START + WINDOW_MS - 1)).toBe(true);
    expect(effectiveWindow(window, START + WINDOW_MS)).toEqual({ ...window, status: 'expired' });
    expect(isWindowActive(window, START + WINDOW_MS)).toBe(false);
    expect(isWindowActive(null, START)).toBe(false);
    expect(expireWindow(window)).not.toBe(window);
    expect(window.status).toBe('active');
  });
});

describe('in-memory translation window repository', () => {
  it('validates writes and returns copies', async () => {
    const repository = new InMemoryTranslationWindowRepository();
    const window = openWindow(DESTINATION, 'ja', START, WINDOW_MS);
    await expect(repository.save({ ...window, expiresAtMs: START })).rejects.toThrow();
    await repository.save(window);
    const stored = await repository.findByChannel(DESTINATION);
    expect(stored).toEqual(window);
    if (stored) stored.status = 'expired';
    expect((await repository.findByChannel(DESTINATION))?.status).toBe('active');
    expect(await repository.findByChannel(SOURCE)).toBeNull();
  });
});

interface Behavior {
  request: RaidRequestResult;
  cancel: RaidCancelResult;
}

function setup(options: { raid?: Partial<Behavior>; config?: Partial<RouletteConfig> } = {}) {
  const time = new ManualTime(START);
  const errors: string[] = [];
  const publisher = new EventPublisher({ clock: time, onError: (kind) => { errors.push(kind); } });
  const events: ServerEvent[] = [];
  for (const streamer of syntheticStreamers) publisher.subscribe(streamer.id, (event) => { events.push(event); });
  const behavior: Behavior = {
    request: { outcome: 'accepted', requestedAtMs: START + VOTING_MS, estimatedCountdownSeconds: 90 },
    cancel: 'cancelled', ...options.raid,
  };
  const coordinator = new RouletteCoordinator({
    clock: time, scheduler: time, random: new ScriptedRandom([]),
    streamers: new InMemoryStreamerRepository(syntheticStreamers), sessions: new InMemoryRouletteRepository(),
    candidates: { listLiveChannels: async () => syntheticLiveChannels },
    raids: { requestRaid: async () => behavior.request, cancelRaid: async () => behavior.cancel },
    publisher, onError: (kind) => { errors.push(kind); },
    ...(options.config ? { config: options.config } : {}),
  });

  let messageNumber = 0;
  const command = (type: 'roulette' | 'cancel') => coordinator.handleCommand({
    messageId: `message-${messageNumber++}`, channelId: SOURCE, userId: SOURCE, role: 'broadcaster', command: { type },
  });
  const vote = (language: LanguageCode) => coordinator.handleCommand({
    messageId: `message-${messageNumber++}`, channelId: SOURCE, userId: `viewer-${messageNumber}`, role: 'viewer',
    command: { type: 'vote', language },
  });
  // Runs one round that requests a raid to the ja destination.
  const raidToDestination = async () => {
    await command('roulette');
    await vote('ja');
    await time.advance(VOTING_MS);
  };
  const arrive = (eventId: string) => coordinator.handleArrival({
    eventId, fromChannelId: SOURCE, toChannelId: DESTINATION, viewers: 12, observedAtMs: time.now(),
  });
  // Lets the destination queue run the window task that an arrival enqueues.
  const settle = () => time.advance(0);
  const windowEvents = () => events.filter(
    (event): event is Extract<ServerEvent, { type: 'translation:window' }> => event.type === 'translation:window',
  );
  return { time, events, errors, coordinator, command, raidToDestination, arrive, settle, windowEvents };
}

describe('translation window lifecycle in the coordinator', () => {
  it('opens on a confirmed arrival with the destination language and expires after 15 minutes', async () => {
    const h = setup();
    await h.raidToDestination();
    // A requested raid is not an arrival, so no window exists yet.
    expect(h.windowEvents()).toEqual([]);
    expect((await h.coordinator.snapshot(DESTINATION)).translationWindow).toBeNull();

    await h.arrive('arrival-1');
    await h.settle();
    const openedAtMs = h.time.now();
    const expected: TranslationWindow = {
      channelId: DESTINATION, status: 'active', targetLanguage: 'ja',
      activatedAtMs: openedAtMs, expiresAtMs: openedAtMs + WINDOW_MS,
    };
    expect(h.windowEvents()).toHaveLength(1);
    expect(h.windowEvents()[0]).toMatchObject({ channelId: DESTINATION, payload: expected });
    expect((await h.coordinator.snapshot(DESTINATION)).translationWindow).toEqual(expected);
    // The source keeps no window from raiding out.
    expect((await h.coordinator.snapshot(SOURCE)).translationWindow).toBeNull();

    await h.time.advance(WINDOW_MS - 1);
    expect(h.windowEvents()).toHaveLength(1);
    expect(await h.coordinator.translationWindow(DESTINATION)).toMatchObject({ status: 'active' });

    await h.time.advance(1);
    expect(h.windowEvents().map((event) => event.payload.status)).toEqual(['active', 'expired']);
    expect((await h.coordinator.snapshot(DESTINATION)).translationWindow).toEqual({ ...expected, status: 'expired' });
    expect(h.time.pendingCount()).toBe(0);
    for (const event of h.events) expect(serverEventSchema.safeParse(event).success).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('includes the current window in the snapshot of a viewer that connects later', async () => {
    const h = setup();
    await h.raidToDestination();
    await h.arrive('arrival-1');
    await h.settle();
    const view = await h.coordinator.openView(DESTINATION, () => undefined);
    expect(view?.snapshot).toMatchObject({
      type: 'state:snapshot', channelId: DESTINATION,
      payload: { translationWindow: { channelId: DESTINATION, status: 'active', targetLanguage: 'ja' } },
    });
    view?.close();
  });

  it('restarts the full duration on a later arrival and ignores the replaced timer', async () => {
    const h = setup();
    await h.raidToDestination();
    await h.arrive('arrival-1');
    await h.settle();
    await h.time.advance(10 * 60_000);

    await h.raidToDestination();
    await h.arrive('arrival-2');
    await h.settle();
    const reopenedAtMs = h.time.now();
    expect(h.windowEvents().map((event) => event.payload.status)).toEqual(['active', 'active']);
    expect(h.windowEvents()[1]?.payload).toMatchObject({ activatedAtMs: reopenedAtMs, expiresAtMs: reopenedAtMs + WINDOW_MS });

    // The first deadline passes without closing the replacement window.
    await h.time.advance(WINDOW_MS - 1);
    expect(h.windowEvents()).toHaveLength(2);
    await h.time.advance(1);
    expect(h.windowEvents().map((event) => event.payload.status)).toEqual(['active', 'active', 'expired']);
    expect(h.errors).toEqual([]);
  });

  it.each([
    ['rejected', { request: { outcome: 'rejected' } }],
    ['unknown', { request: { outcome: 'unknown' } }],
  ] as const)('opens no window when the raid request is %s', async (_label, raid) => {
    const h = setup({ raid });
    await h.raidToDestination();
    await h.arrive('arrival-1');
    await h.settle();
    expect(h.windowEvents()).toEqual([]);
    expect(await h.coordinator.translationWindow(DESTINATION)).toBeNull();
  });

  it('opens no window for an arrival after a cancelled raid', async () => {
    const h = setup();
    await h.raidToDestination();
    await h.command('cancel');
    await h.arrive('arrival-1');
    await h.settle();
    expect(h.windowEvents()).toEqual([]);
    expect(h.time.pendingCount()).toBe(0);
  });

  it('stops the expiry timer on close', async () => {
    const h = setup();
    await h.raidToDestination();
    await h.arrive('arrival-1');
    await h.settle();
    expect(h.time.pendingCount()).toBe(1);
    h.coordinator.close();
    expect(h.time.pendingCount()).toBe(0);
  });

  it('honours a configured duration and rejects an invalid one', async () => {
    const h = setup({ config: { translationWindowMs: 60_000 } });
    await h.raidToDestination();
    await h.arrive('arrival-1');
    await h.settle();
    await h.time.advance(60_000);
    expect(h.windowEvents().map((event) => event.payload.status)).toEqual(['active', 'expired']);
    expect(() => setup({ config: { translationWindowMs: 0 } })).toThrow();
  });
});
