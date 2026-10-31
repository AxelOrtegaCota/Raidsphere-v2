import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@raidsphere/shared';
import type { ChatCommand, RaidArrival } from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { RouletteCoordinator } from '../src/application/roulette.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from '../src/persistence/memory.js';
import { CommandSimulator } from '../src/simulation/commands.js';
import { syntheticCandidateSource, syntheticStreamers } from '../src/simulation/fixtures.js';
import { SimulatedRaidGateway } from '../src/simulation/raid-gateway.js';
import type { SimulatedRaidOptions } from '../src/simulation/raid-gateway.js';
import { ManualTime, ScriptedRandom } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures.
const SOURCE = 'rsdemo_es_01';
const request = { sessionId: 'session-a', fromChannelId: SOURCE, toStreamerId: 'rsdemo_ja_01' };

function gateway(options: Partial<SimulatedRaidOptions> = {}) {
  const time = new ManualTime(0);
  const arrivals: RaidArrival[] = [];
  const raids = new SimulatedRaidGateway({
    clock: time, scheduler: time, onArrival: (arrival) => { arrivals.push(arrival); }, options,
  });
  return { time, arrivals, raids };
}

describe('command simulator', () => {
  it('sends normalized commands with unique message IDs and the expected roles', async () => {
    const commands: ChatCommand[] = [];
    const simulator = new CommandSimulator({ handleCommand: async (command) => { commands.push(command); } }, SOURCE);
    await simulator.roulette();
    await simulator.vote('viewer-1', 'ja');
    await simulator.cancel({ userId: 'moderator-1', role: 'moderator' });
    expect(commands.map(({ userId, role, command }) => [userId, role, command])).toEqual([
      [SOURCE, 'broadcaster', { type: 'roulette' }],
      ['viewer-1', 'viewer', { type: 'vote', language: 'ja' }],
      ['moderator-1', 'moderator', { type: 'cancel' }],
    ]);
    expect(commands.every((command) => command.channelId === SOURCE)).toBe(true);
    expect(new Set(commands.map((command) => command.messageId)).size).toBe(3);
  });
});

describe('simulated raid gateway', () => {
  it('accepts by default and delivers the arrival when the countdown ends', async () => {
    const { time, arrivals, raids } = gateway();
    expect(await raids.requestRaid(request)).toEqual({ outcome: 'accepted', requestedAtMs: 0, estimatedCountdownSeconds: 90 });
    await time.advance(89_999);
    expect(arrivals).toEqual([]);
    await time.advance(1);
    expect(arrivals).toEqual([{
      eventId: 'sim-arrival-session-a', fromChannelId: SOURCE, toChannelId: 'rsdemo_ja_01', viewers: 15, observedAtMs: 90_000,
    }]);
  });

  it.each(['rejected', 'unknown'] as const)('returns a configured %s request outcome without an arrival', async (requestOutcome) => {
    const { time, arrivals, raids } = gateway({ requestOutcome });
    expect(await raids.requestRaid(request)).toEqual({ outcome: requestOutcome });
    await time.advance(200_000);
    expect(arrivals).toEqual([]);
  });

  it('can withhold the arrival and use a shorter countdown', async () => {
    const { time, arrivals, raids } = gateway({ deliverArrival: false, countdownSeconds: 10 });
    expect((await raids.requestRaid(request)).outcome).toBe('accepted');
    await time.advance(200_000);
    expect(arrivals).toEqual([]);
    expect(time.pendingCount()).toBe(0);
  });

  it('rejects countdowns outside the contract range', () => {
    for (const countdownSeconds of [-1, 1.5, 121]) expect(() => gateway({ countdownSeconds })).toThrow();
  });

  it('is idempotent per session', async () => {
    const { time, arrivals, raids } = gateway();
    await raids.requestRaid(request);
    await time.advance(1_000);
    expect(await raids.requestRaid(request)).toEqual({ outcome: 'accepted', requestedAtMs: 0, estimatedCountdownSeconds: 90 });
    await time.advance(100_000);
    expect(arrivals).toHaveLength(1);
  });

  it.each([
    ['cancelled', 0],
    ['not_cancelled', 1],
    ['unknown', 1],
  ] as const)('returns a configured %s cancellation result', async (cancelOutcome, expectedArrivals) => {
    const { time, arrivals, raids } = gateway({ cancelOutcome });
    await raids.requestRaid(request);
    expect(await raids.cancelRaid(request)).toBe(cancelOutcome);
    await time.advance(100_000);
    expect(arrivals).toHaveLength(expectedArrivals);
  });

  it('stops pending arrivals on close', async () => {
    const { time, arrivals, raids } = gateway();
    await raids.requestRaid(request);
    raids.close();
    await time.advance(100_000);
    expect(arrivals).toEqual([]);
  });
});

describe('simulated roulette end to end', () => {
  it('reaches a confirmed arrival with only simulated adapters', async () => {
    const time = new ManualTime(1_000_000);
    const events: ServerEvent[] = [];
    const errors: string[] = [];
    const publisher = new EventPublisher({ clock: time, onError: (kind) => { errors.push(kind); } });
    for (const streamer of syntheticStreamers) publisher.subscribe(streamer.id, (event) => { events.push(event); });
    let coordinator: RouletteCoordinator | null = null;
    const raids = new SimulatedRaidGateway({
      clock: time, scheduler: time, options: { countdownSeconds: 10 },
      onArrival: (arrival) => coordinator?.handleArrival(arrival),
    });
    coordinator = new RouletteCoordinator({
      clock: time, scheduler: time, random: new ScriptedRandom([]),
      streamers: new InMemoryStreamerRepository(syntheticStreamers), sessions: new InMemoryRouletteRepository(),
      candidates: syntheticCandidateSource, raids, publisher, onError: (kind) => { errors.push(kind); },
    });
    const chat = new CommandSimulator(coordinator, SOURCE);

    await chat.roulette();
    await chat.vote('viewer-1', 'pt');
    await chat.vote('viewer-2', 'pt');
    await chat.vote('viewer-3', 'ko');
    await time.advance(30_000);
    await time.advance(10_000);

    expect(events.filter((event) => event.channelId === SOURCE).map((event) => event.type)).toEqual([
      'roulette:start', 'roulette:votes', 'roulette:votes', 'roulette:chosen', 'raid:started', 'state:snapshot',
    ]);
    expect(events.filter((event) => event.channelId === 'rsdemo_pt_01').map((event) => event.type)).toEqual([
      'raid:arrived', 'translation:window',
    ]);
    expect((await coordinator.snapshot(SOURCE)).roulette?.status).toBe('done');
    // Only the destination's translation window expiry remains scheduled.
    expect(time.pendingCount()).toBe(1);
    expect(errors).toEqual([]);
  });
});
