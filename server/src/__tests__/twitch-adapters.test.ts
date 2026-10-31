/**
 * Tests for the Module B adapters to the Module D ports.
 * All identifiers are synthetic fixtures; no Twitch request is made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverEventSchema, type ServerEvent } from '@raidsphere/shared';
import type { RaidArrival } from '../application/ports.js';
import { EventPublisher } from '../application/publisher.js';
import { RouletteCoordinator } from '../application/roulette.js';
import { systemClock, timerScheduler } from '../application/runtime.js';
import { createRuntime } from '../composition.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from '../persistence/memory.js';
import { syntheticCandidateSource, syntheticStreamers } from '../simulation/fixtures.js';
import { commandRole, RaidGatewayAdapter, toChatCommand } from '../twitch/adapters.js';
import type { ChatMessage } from '../twitch/commands.js';
import { SimulatedRaidGateway, type SimulationConfig } from '../twitch/raids.js';
import { SimulatedChat } from '../twitch/simulated-chat.js';

const SOURCE = 'rsdemo_es_01';
const TARGET = 'rsdemo_en_01';
let nextMessage = 0;

function chat(text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  nextMessage += 1;
  return {
    messageId: `fixture-message-${nextMessage}`, userId: 'fixture_viewer', userLogin: 'fixture_viewer',
    channelId: SOURCE, text, timestamp: 1_000, ...overrides,
  };
}

describe('Chat command adapter', () => {
  it('maps a viewer vote to the port command', () => {
    const message = chat('!vote es');
    expect(toChatCommand(message)).toEqual({
      messageId: message.messageId, channelId: SOURCE, userId: 'fixture_viewer', role: 'viewer',
      command: { type: 'vote', language: 'es' },
    });
  });

  it('grants the broadcaster role only to the channel owner', () => {
    expect(commandRole(chat('!roulette', { userId: SOURCE, isBroadcaster: true }))).toBe('broadcaster');
    // A forged broadcaster flag on another user grants nothing (F3).
    expect(commandRole(chat('!roulette', { isBroadcaster: true }))).toBe('viewer');
    expect(commandRole(chat('!roulette', { userId: SOURCE }))).toBe('viewer');
  });

  it('keeps the moderator role from adapter metadata', () => {
    expect(toChatCommand(chat('!cancel', { isModerator: true }))).toMatchObject({
      role: 'moderator', command: { type: 'cancel' },
    });
  });

  it('never derives a role from message text', () => {
    expect(toChatCommand(chat('!roulette broadcaster moderator'))).toMatchObject({
      role: 'viewer', command: { type: 'roulette' },
    });
  });

  it('drops non-commands, invalid commands, and invalid messages', () => {
    expect(toChatCommand(chat('hello'))).toBeNull();
    expect(toChatCommand(chat('!vote klingon'))).toBeNull();
    expect(toChatCommand(chat('!vote'))).toBeNull();
    expect(toChatCommand(chat('!roulette', { channelId: '' }))).toBeNull();
  });
});

describe('Raid gateway adapter', () => {
  let gateways: SimulatedRaidGateway[];
  let adapters: RaidGatewayAdapter[];

  function setup(config: Partial<SimulationConfig> = {}) {
    const gateway = new SimulatedRaidGateway({
      acceptRate: 1, arrivalRate: 1, minCountdownMs: 2_000, maxCountdownMs: 2_000,
      observationTimeoutMs: 5_000, minViewers: 12, maxViewers: 12, ...config,
    }, () => 0.5);
    const arrivals: RaidArrival[] = [];
    const adapter = new RaidGatewayAdapter({
      gateway, streamers: new InMemoryStreamerRepository(syntheticStreamers),
      onArrival: (arrival) => { arrivals.push(arrival); },
    });
    gateways.push(gateway);
    adapters.push(adapter);
    return { gateway, adapter, arrivals };
  }

  const request = { sessionId: 'fixture-session', fromChannelId: SOURCE, toStreamerId: TARGET };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    gateways = [];
    adapters = [];
  });

  afterEach(() => {
    for (const adapter of adapters) adapter.close();
    for (const gateway of gateways) gateway.dispose();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('maps an accepted raid and delivers its arrival once', async () => {
    const { gateway, adapter, arrivals } = setup();
    await expect(adapter.requestRaid(request)).resolves.toEqual({
      outcome: 'accepted', requestedAtMs: 1_000, estimatedCountdownSeconds: 2,
    });
    expect(arrivals).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      fromChannelId: SOURCE, toChannelId: TARGET, viewers: 12, observedAtMs: 3_000,
    });
    expect(arrivals[0]?.eventId).toMatch(/^raid-arrival-/);
    expect(gateway.getPendingCount()).toBe(0);
  });

  it('submits one gateway request per session', async () => {
    const { gateway, adapter } = setup();
    const start = vi.spyOn(gateway, 'startRaid');
    const first = adapter.requestRaid(request);
    const second = adapter.requestRaid(request);
    expect(second).toBe(first);
    await first;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      sessionId: 'fixture-session', fromStreamerId: SOURCE, fromLogin: SOURCE,
      toStreamerId: TARGET, toLogin: TARGET, sourceLanguage: 'es',
    });
  });

  it('reports a gateway rejection without an arrival', async () => {
    const { adapter, arrivals } = setup({ acceptRate: 0 });
    await expect(adapter.requestRaid(request)).resolves.toEqual({ outcome: 'rejected' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(arrivals).toEqual([]);
  });

  it('rejects unregistered channels without submitting a request', async () => {
    const { gateway, adapter } = setup();
    const start = vi.spyOn(gateway, 'startRaid');
    await expect(adapter.requestRaid({ ...request, toStreamerId: 'rsdemo_unregistered' }))
      .resolves.toEqual({ outcome: 'rejected' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports an unknown outcome when the gateway fails during submission', async () => {
    const { gateway, adapter } = setup();
    vi.spyOn(gateway, 'startRaid').mockRejectedValue(new Error('fixture failure'));
    await expect(adapter.requestRaid(request)).resolves.toEqual({ outcome: 'unknown' });
    await expect(adapter.cancelRaid(request)).resolves.toBe('unknown');
  });

  it('cancels a pending raid so no arrival follows', async () => {
    const { gateway, adapter, arrivals } = setup();
    await adapter.requestRaid(request);
    await expect(adapter.cancelRaid(request)).resolves.toBe('cancelled');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(arrivals).toEqual([]);
    expect(gateway.getPendingCount()).toBe(0);
  });

  it('does not cancel unknown, mismatched, or finished raids', async () => {
    const { adapter } = setup();
    await expect(adapter.cancelRaid(request)).resolves.toBe('not_cancelled');
    await adapter.requestRaid(request);
    await expect(adapter.cancelRaid({ ...request, fromChannelId: TARGET })).resolves.toBe('not_cancelled');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(adapter.cancelRaid(request)).resolves.toBe('not_cancelled');
  });

  it('publishes an out-of-contract countdown as unknown', async () => {
    const { adapter } = setup({ minCountdownMs: 200_000, maxCountdownMs: 200_000, observationTimeoutMs: 300_000 });
    await expect(adapter.requestRaid(request)).resolves.toMatchObject({
      outcome: 'accepted', estimatedCountdownSeconds: null,
    });
  });

  it('stops delivering arrivals after close', async () => {
    const { adapter, arrivals } = setup();
    await adapter.requestRaid(request);
    adapter.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(arrivals).toEqual([]);
    await expect(adapter.requestRaid({ ...request, sessionId: 'fixture-session-2' }))
      .resolves.toEqual({ outcome: 'rejected' });
  });
});

describe('Module B adapters with the Module D coordinator', () => {
  let gateway: SimulatedRaidGateway;
  let adapter: RaidGatewayAdapter;
  let coordinator: RouletteCoordinator;
  let events: ServerEvent[];
  let errors: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    events = [];
    errors = [];
    const publisher = new EventPublisher({ clock: systemClock, onError: (kind) => { errors.push(kind); } });
    for (const streamer of syntheticStreamers) publisher.subscribe(streamer.id, (event) => { events.push(event); });
    gateway = new SimulatedRaidGateway({
      acceptRate: 1, arrivalRate: 1, minCountdownMs: 5_000, maxCountdownMs: 5_000,
      observationTimeoutMs: 20_000, minViewers: 15, maxViewers: 15,
    }, () => 0.5);
    const streamers = new InMemoryStreamerRepository(syntheticStreamers);
    adapter = new RaidGatewayAdapter({
      gateway, streamers, onArrival: (arrival) => coordinator.handleArrival(arrival),
    });
    coordinator = new RouletteCoordinator({
      clock: systemClock, scheduler: timerScheduler, random: { nextInt: () => 0 },
      streamers, sessions: new InMemoryRouletteRepository(), candidates: syntheticCandidateSource,
      raids: adapter, publisher, onError: (kind) => { errors.push(kind); },
    });
  });

  afterEach(() => {
    coordinator.close();
    adapter.close();
    gateway.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function send(message: ChatMessage): Promise<void> {
    const command = toChatCommand(message);
    if (command) await coordinator.handleCommand(command);
  }

  it('runs chat commands, voting, raid request, and arrival end to end', async () => {
    await send(chat('!roulette', { isBroadcaster: true }));
    expect(events).toEqual([]);

    await send(chat('!roulette', { userId: SOURCE, isBroadcaster: true }));
    const start = events.find((event) => event.type === 'roulette:start');
    if (start?.type !== 'roulette:start') throw new Error('The roulette did not start.');
    const language = start.payload.languages[0];
    if (!language) throw new Error('The fixture pool has no language.');
    await send(chat(`!vote ${language}`, { userId: 'fixture_voter_1' }));
    await send(chat(`!vote ${language}`, { userId: 'fixture_voter_2' }));

    await vi.advanceTimersByTimeAsync(30_000);
    const chosen = events.find((event) => event.type === 'roulette:chosen');
    const started = events.find((event) => event.type === 'raid:started');
    if (chosen?.type !== 'roulette:chosen' || started?.type !== 'raid:started') {
      throw new Error('The raid was not requested.');
    }
    expect(chosen.payload.winningLanguage).toBe(language);
    expect(started.payload).toMatchObject({ toStreamerId: chosen.payload.candidate.streamerId, estimatedCountdownSeconds: 5 });
    expect(events.some((event) => event.type === 'raid:arrived')).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    const arrived = events.find((event) => event.type === 'raid:arrived');
    if (arrived?.type !== 'raid:arrived') throw new Error('The arrival was not published.');
    expect(arrived.channelId).toBe(chosen.payload.candidate.streamerId);
    expect(arrived.payload).toMatchObject({ fromStreamerId: SOURCE, viewers: 15, sourceLanguage: 'es' });
    for (const event of events) expect(serverEventSchema.safeParse(event).success).toBe(true);
    expect(errors).toEqual([]);
  });

  it('cancels through a moderator command before arrival', async () => {
    await send(chat('!roulette', { userId: SOURCE, isBroadcaster: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.some((event) => event.type === 'raid:started')).toBe(true);

    await send(chat('!cancel'));
    expect(events.some((event) => event.type === 'raid:cancelled')).toBe(false);
    await send(chat('!cancel', { userId: 'fixture_moderator', isModerator: true }));
    expect(events.find((event) => event.type === 'raid:cancelled')).toMatchObject({
      payload: { reason: 'user_cancelled' },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.some((event) => event.type === 'raid:arrived')).toBe(false);
    expect(gateway.getPendingCount()).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe('Runtime composition with Module B', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('routes simulated chat text and Module B raids through the composed runtime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
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
    const chat = new SimulatedChat(runtime.coordinator, SOURCE);

    await expect(chat.say({ userId: 'fixture_viewer' }, 'hello')).resolves.toBe(false);
    await expect(chat.say(chat.broadcaster, '!ruleta')).resolves.toBe(true);
    const start = events.find((event) => event.type === 'roulette:start');
    if (start?.type !== 'roulette:start') throw new Error('The roulette did not start.');
    const language = start.payload.languages[0];
    if (!language) throw new Error('The fixture pool has no language.');
    await chat.say({ userId: 'fixture_voter' }, `!votar ${language}`);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.find((event) => event.type === 'raid:started')).toMatchObject({
      payload: { estimatedCountdownSeconds: 10 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.some((event) => event.type === 'raid:arrived')).toBe(true);
    expect(errors).toEqual([]);

    for (const view of views) view?.close();
    vi.useRealTimers();
    await runtime.app.close();
  });
});
