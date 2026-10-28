import { describe, expect, it } from 'vitest';
import type { LanguageCode, ServerEvent } from '@raidsphere/shared';
import type {
  ChatCommand, CommandRole, LiveChannel, RaidArrival, RaidCancelResult, RaidRequestResult,
} from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { RouletteCoordinator } from '../src/application/roulette.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from '../src/persistence/memory.js';
import { syntheticLiveChannels, syntheticStreamers } from '../src/simulation/fixtures.js';
import { ManualTime, ScriptedRandom } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures. The demo source pool is
// rsdemo_en_01, rsdemo_es_02, rsdemo_pt_01, rsdemo_ja_01, rsdemo_ko_02 (languages en, es, pt, ja, ko).
const SOURCE = 'rsdemo_es_01';
const START = 1_000_000;
const VOTING_MS = 30_000;

interface RaidBehavior {
  request: RaidRequestResult | 'hang';
  cancel: RaidCancelResult;
}

function setup(options: { random?: number[]; live?: readonly LiveChannel[]; raid?: Partial<RaidBehavior> } = {}) {
  const time = new ManualTime(START);
  const publisher = new EventPublisher({
    clock: time, onError: (kind) => { throw new Error(`Publisher error: ${kind}`); },
  });
  const events: ServerEvent[] = [];
  for (const streamer of [...syntheticStreamers, { id: 'rsdemo_unregistered' }]) {
    publisher.subscribe(streamer.id, (event) => { events.push(event); });
  }
  const behavior: RaidBehavior = {
    request: { outcome: 'accepted', requestedAtMs: START + VOTING_MS, estimatedCountdownSeconds: 90 },
    cancel: 'cancelled', ...options.raid,
  };
  const raidCalls: string[] = [];
  const errors: string[] = [];
  const coordinator = new RouletteCoordinator({
    clock: time, scheduler: time, random: new ScriptedRandom(options.random ?? []),
    streamers: new InMemoryStreamerRepository(syntheticStreamers),
    sessions: new InMemoryRouletteRepository(),
    candidates: { listLiveChannels: async () => options.live ?? syntheticLiveChannels },
    raids: {
      requestRaid: async (request) => {
        raidCalls.push(`request:${request.toStreamerId}`);
        return behavior.request === 'hang' ? new Promise<never>(() => {}) : behavior.request;
      },
      cancelRaid: async () => {
        raidCalls.push('cancel');
        return behavior.cancel;
      },
    },
    publisher, onError: (kind) => { errors.push(kind); },
  });

  let messageNumber = 0;
  const send = (
    command: ChatCommand['command'], userId = SOURCE, role: CommandRole = 'broadcaster',
    messageId = `message-${messageNumber++}`,
  ) => coordinator.handleCommand({ messageId, channelId: SOURCE, userId, role, command });
  const start = () => send({ type: 'roulette' });
  const vote = (userId: string, language: LanguageCode, messageId?: string) =>
    send({ type: 'vote', language }, userId, 'viewer', messageId);
  const arrive = (overrides: Partial<RaidArrival> = {}) => coordinator.handleArrival({
    eventId: 'arrival-1', fromChannelId: SOURCE, toChannelId: 'rsdemo_en_01', viewers: 15,
    observedAtMs: time.now(), ...overrides,
  });
  const types = (channelId = SOURCE) => events.filter((event) => event.channelId === channelId).map((event) => event.type);
  const last = <T extends ServerEvent['type']>(type: T) =>
    events.filter((event): event is Extract<ServerEvent, { type: T }> => event.type === type).at(-1);
  const status = async () => (await coordinator.snapshot(SOURCE)).roulette?.status;
  return { time, events, errors, raidCalls, coordinator, send, start, vote, arrive, types, last, status };
}

describe('roulette flow', () => {
  it('runs from !roulette through voting, selection, raid request, and arrival', async () => {
    const h = setup();
    await h.start();
    const started = h.last('roulette:start');
    expect(started?.payload.candidates.map((candidate) => candidate.streamerId)).toEqual([
      'rsdemo_en_01', 'rsdemo_es_02', 'rsdemo_pt_01', 'rsdemo_ja_01', 'rsdemo_ko_02',
    ]);
    expect(started?.payload.languages).toEqual(['en', 'es', 'pt', 'ja', 'ko']);
    expect(started?.payload.votingEndsAtMs).toBe(START + VOTING_MS);

    await h.vote('viewer-1', 'ja');
    await h.time.advance(200);
    await h.vote('viewer-2', 'ja');
    expect(h.types()).toEqual(['roulette:start', 'roulette:votes']);
    await h.time.advance(800);
    expect(h.last('roulette:votes')?.payload).toEqual({ votes: { ja: 2 }, totalVotes: 2 });

    await h.time.advance(29_000);
    expect(h.last('roulette:chosen')?.payload).toMatchObject({
      candidate: { streamerId: 'rsdemo_ja_01' }, winningLanguage: 'ja', fromCountry: 'MX', toCountry: 'JP',
    });
    expect(h.raidCalls).toEqual(['request:rsdemo_ja_01']);
    expect(h.last('raid:started')?.payload).toMatchObject({ toStreamerId: 'rsdemo_ja_01', estimatedCountdownSeconds: 90 });
    expect(h.types()).toEqual(['roulette:start', 'roulette:votes', 'roulette:votes', 'roulette:chosen', 'raid:started']);
    expect(await h.status()).toBe('raid_pending');

    await h.arrive({ toChannelId: 'rsdemo_ja_01', observedAtMs: START + 40_000 });
    expect(h.types('rsdemo_ja_01')).toEqual(['raid:arrived']);
    expect(h.last('raid:arrived')).toMatchObject({
      channelId: 'rsdemo_ja_01', sessionId: started?.sessionId,
      payload: {
        fromStreamerId: SOURCE, fromLogin: SOURCE, toStreamerId: 'rsdemo_ja_01',
        viewers: 15, sourceLanguage: 'es', arrivedAtMs: START + 40_000,
      },
    });
    expect(await h.status()).toBe('done');
    expect(h.time.pendingCount()).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it('sends the final counts at close and breaks ties by a draw among the tied languages', async () => {
    const h = setup({ random: [1] });
    await h.start();
    await h.time.advance(29_500);
    await h.vote('viewer-1', 'en');
    await h.time.advance(200);
    await h.vote('viewer-2', 'pt');
    expect(h.types()).toEqual(['roulette:start', 'roulette:votes']);
    await h.time.advance(300);
    expect(h.types()).toEqual(['roulette:start', 'roulette:votes', 'roulette:votes', 'roulette:chosen', 'raid:started']);
    expect(h.last('roulette:votes')?.payload).toEqual({ votes: { en: 1, pt: 1 }, totalVotes: 2 });
    expect(h.last('roulette:chosen')?.payload).toMatchObject({ winningLanguage: 'pt', candidate: { streamerId: 'rsdemo_pt_01' } });
    expect(h.errors).toEqual([]);
  });

  it('draws among every pool language when nobody votes', async () => {
    const h = setup({ random: [3] });
    await h.start();
    await h.time.advance(VOTING_MS);
    expect(h.types()).toEqual(['roulette:start', 'roulette:chosen', 'raid:started']);
    expect(h.last('roulette:chosen')?.payload.winningLanguage).toBe('ja');
    expect(h.errors).toEqual([]);
  });

  it('opens a view with the latest state, then delivers only later events', async () => {
    const h = setup();
    await h.start();
    const received: ServerEvent[] = [];
    const view = await h.coordinator.openView(SOURCE, (event) => { received.push(event); });
    if (!view) throw new Error('Expected a view.');
    expect(view.snapshot).toMatchObject({ type: 'state:snapshot', channelId: SOURCE, payload: { roulette: { status: 'voting' } } });
    await h.vote('viewer-1', 'en');
    expect(received.map((event) => event.type)).toEqual(['roulette:votes']);
    expect((received[0]?.sequence ?? 0) > view.snapshot.sequence).toBe(true);
    view.close();
    await h.send({ type: 'cancel' });
    expect(received).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('counts one vote per user and ignores duplicate messages', async () => {
    const h = setup();
    await h.start();
    await h.vote('viewer-1', 'ko', 'duplicate');
    await h.vote('viewer-2', 'ko', 'duplicate');
    await h.vote('viewer-1', 'pt');
    await h.vote('viewer-3', 'de');
    await h.time.advance(VOTING_MS);
    expect((await h.coordinator.snapshot(SOURCE)).roulette?.votes).toEqual({ ko: 1 });
    expect(h.last('roulette:chosen')?.payload.winningLanguage).toBe('ko');
    expect(h.errors).toEqual([]);
  });
});

describe('roulette commands', () => {
  it('accepts control only from the broadcaster or moderators and ignores out-of-place commands', async () => {
    const h = setup();
    await h.send({ type: 'roulette' }, 'viewer-1', 'viewer');
    await h.send({ type: 'roulette' }, 'someone-else', 'broadcaster');
    await h.send({ type: 'cancel' }, SOURCE, 'broadcaster');
    expect(h.types()).toEqual([]);
    await h.send({ type: 'roulette' }, 'moderator-1', 'moderator');
    await h.send({ type: 'roulette' }, SOURCE, 'broadcaster');
    await h.send({ type: 'cancel' }, 'viewer-1', 'viewer');
    expect(h.types()).toEqual(['roulette:start']);
    await h.send({ type: 'cancel' }, 'moderator-1', 'moderator');
    expect(h.last('raid:cancelled')?.payload.reason).toBe('session_cancelled_before_request');
    expect(h.errors).toEqual([]);
  });

  it('cancels during voting, stops its timers, and allows a new session', async () => {
    const h = setup();
    await h.start();
    const first = h.last('roulette:start')?.sessionId;
    await h.vote('viewer-1', 'en');
    await h.send({ type: 'cancel' });
    expect(await h.status()).toBe('cancelled');
    expect(h.time.pendingCount()).toBe(0);
    await h.time.advance(2 * VOTING_MS);
    expect(h.types()).toEqual(['roulette:start', 'roulette:votes', 'raid:cancelled']);
    await h.start();
    expect(h.last('roulette:start')?.sessionId).not.toBe(first);
    expect(h.errors).toEqual([]);
  });

  it('reports no eligible candidates without creating a session and ignores unregistered channels', async () => {
    const h = setup({ live: syntheticLiveChannels.filter((channel) => channel.streamer.id === SOURCE) });
    await h.start();
    const error = h.last('error');
    expect(error?.payload).toMatchObject({ code: 'NO_ELIGIBLE_CANDIDATES', recoverable: true });
    expect(error?.sessionId).toBeUndefined();
    expect((await h.coordinator.snapshot(SOURCE)).roulette).toBeNull();
    await h.coordinator.handleCommand({
      messageId: 'unregistered', channelId: 'rsdemo_unregistered', userId: 'rsdemo_unregistered',
      role: 'broadcaster', command: { type: 'roulette' },
    });
    expect(h.types('rsdemo_unregistered')).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});

describe('raid outcomes', () => {
  it('fails the session when the raid request is rejected', async () => {
    const h = setup({ random: [0], raid: { request: { outcome: 'rejected' } } });
    await h.start();
    await h.time.advance(VOTING_MS);
    expect(h.types()).toEqual(['roulette:start', 'roulette:chosen', 'error']);
    expect(h.last('error')).toMatchObject({
      sessionId: h.last('roulette:start')?.sessionId, payload: { code: 'RAID_REJECTED', recoverable: true },
    });
    expect(await h.status()).toBe('failed');
    expect(h.time.pendingCount()).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it('treats a raid request that never answers as unknown after the call timeout', async () => {
    const h = setup({ random: [0], raid: { request: 'hang' } });
    await h.start();
    await h.time.advance(VOTING_MS);
    expect(await h.status()).toBe('chosen');
    await h.time.advance(10_000);
    expect(h.last('error')?.payload.code).toBe('RAID_OUTCOME_UNKNOWN');
    expect(await h.status()).toBe('unknown');
    expect(h.errors).toEqual([]);
  });

  it('never assumes success when the arrival is not observed in time', async () => {
    const h = setup({ random: [0] });
    await h.start();
    await h.time.advance(VOTING_MS);
    await h.time.advance(90_000 + 60_000 - 1);
    expect(await h.status()).toBe('raid_pending');
    await h.time.advance(1);
    expect(h.last('error')?.payload.code).toBe('RAID_OUTCOME_UNKNOWN');
    expect(await h.status()).toBe('unknown');
    await h.arrive();
    expect(h.types('rsdemo_en_01')).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it.each([
    ['cancelled', 'cancelled', 'raid:cancelled'],
    ['not_cancelled', 'raid_pending', 'raid:started'],
    ['unknown', 'unknown', 'error'],
  ] as const)('handles a %s cancellation result while the raid is pending', async (cancel, expectedStatus, lastType) => {
    const h = setup({ random: [0], raid: { cancel } });
    await h.start();
    await h.time.advance(VOTING_MS);
    await h.send({ type: 'cancel' }, 'moderator-1', 'moderator');
    expect(h.raidCalls).toEqual(['request:rsdemo_en_01', 'cancel']);
    expect(await h.status()).toBe(expectedStatus);
    expect(h.types().at(-1)).toBe(lastType);
    if (cancel === 'cancelled') expect(h.last('raid:cancelled')?.payload.reason).toBe('user_cancelled');
    expect(h.errors).toEqual([]);
  });

  it('ignores arrivals for another destination, duplicates, and arrivals after the session ended', async () => {
    const h = setup({ random: [0] });
    await h.start();
    await h.time.advance(VOTING_MS);
    await h.arrive({ eventId: 'arrival-wrong', toChannelId: 'rsdemo_ko_02' });
    expect(await h.status()).toBe('raid_pending');
    await h.arrive({ eventId: 'arrival-1' });
    await h.arrive({ eventId: 'arrival-1' });
    await h.arrive({ eventId: 'arrival-2' });
    expect(h.types('rsdemo_en_01')).toEqual(['raid:arrived']);
    expect(h.types('rsdemo_ko_02')).toEqual([]);
    expect(await h.status()).toBe('done');
    expect(h.errors).toEqual([]);
  });
});
