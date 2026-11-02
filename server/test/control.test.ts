import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateSchema, serverEventSchema } from '@raidsphere/shared';
import type { RaidRequestResult } from '../src/application/ports.js';
import { EventPublisher } from '../src/application/publisher.js';
import { RouletteCoordinator } from '../src/application/roulette.js';
import { autoCandidates } from '../src/application/selection.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from '../src/persistence/memory.js';
import { registerControlRoutes } from '../src/routes/control.js';
import { RaidGatewayAdapter } from '../src/twitch/adapters.js';
import { SimulatedRaidGateway } from '../src/twitch/raids.js';
import type { Stream } from '../src/twitch/helix.js';
import { createSession, destroySession } from '../src/twitch/sessions.js';
import { ManualTime } from './support/fakes.js';

// Synthetic identities only; provider and raid calls never reach Twitch.
const SOURCE = '1001';
const COOKIE = 'raidsphere_session=control-fixture';
const source = {
  id: SOURCE, login: 'source', displayName: 'Source', avatarUrl: null, language: 'es' as const,
  minViewers: 0, maxViewers: 1_000_000, acceptsOtherLanguages: true, reputation: 0,
};
const stream = (id: string, viewers = 100, language = 'es'): Stream => ({
  id: `stream-${id}`, userId: id, userLogin: id === SOURCE ? 'source' : `channel_${id}`, userName: `Channel ${id}`,
  gameId: '1', gameName: 'Fixture Category', type: 'live', title: 'Fixture stream', viewerCount: viewers,
  startedAt: '2026-11-02T00:00:00Z', language, thumbnailUrl: '', tags: [], isMature: false,
});
const candidate = (id: string, viewers: number, language = 'es') => candidateSchema.parse({
  streamerId: id, login: `channel_${id}`, displayName: `Channel ${id}`, avatarUrl: null,
  language, illustrativeCountry: null, viewers, gameName: 'Fixture', title: 'Fixture',
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  destroySession('control-fixture');
  vi.restoreAllMocks();
});

function setup() {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const session = createSession('control-fixture', {
    id: SOURCE, login: 'source', display_name: 'Source', profile_image_url: 'https://example.com/fixture.png',
    broadcaster_type: '', description: '', created_at: '2026-11-02T00:00:00Z',
  }, {
    access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600,
    scope: ['channel:manage:raids', 'user:read:chat'],
  }, { channelId: SOURCE, viewingCredential: 'fixture-viewing-credential-only' });
  const time = new ManualTime();
  const state = {
    streams: [stream(SOURCE), stream('2002', 50), stream('2003', 200, 'it')], limited: false,
    raid: { outcome: 'accepted', requestedAtMs: time.now(), estimatedCountdownSeconds: 90 } as RaidRequestResult,
    cancel: 'cancelled' as 'cancelled' | 'not_cancelled' | 'unknown',
  };
  const errors: string[] = [];
  const publisher = new EventPublisher({ clock: time, onError: (error) => { errors.push(error); } });
  const streamers = new InMemoryStreamerRepository([source]);
  const random = { nextInt: vi.fn((_max: number) => 0) };
  const requestRaid = vi.fn(async () => state.raid);
  const cancelRaid = vi.fn(async () => state.cancel);
  const coordinator = new RouletteCoordinator({
    clock: time, scheduler: time, random, streamers, sessions: new InMemoryRouletteRepository(),
    candidates: { listLiveChannels: async () => [] }, raids: { requestRaid, cancelRaid }, publisher,
    onError: (error) => { errors.push(error); },
  });
  const readStreams = vi.fn(async (_session: unknown, ids: readonly string[]) => state.streams.filter((entry) => ids.includes(entry.userId)));
  const app: FastifyInstance = Fastify({ logger: false });
  registerControlRoutes(app, {
    coordinator, streamers, random, simulated: true, readStreams,
    discoverStreams: async () => ({ streams: state.streams, limited: state.limited }),
  });
  cleanup.push(async () => { coordinator.close(); await app.close(); });
  const post = (action: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: `/api/control/${action}`, payload,
    headers: { cookie: COOKIE, 'x-raidsphere-control': '1', ...headers },
  });
  const prepare = async (ids = ['2002', '2003']) => (await post('prepare', { channelId: SOURCE, mode: 'manual', candidateIds: ids })).json();
  const spin = async () => {
    const prepared = await prepare();
    return post('spin', { channelId: SOURCE, poolId: prepared.poolId, requestId: randomUUID() });
  };
  const raid = (requestId = randomUUID()) => post('raid', { channelId: SOURCE, toStreamerId: '2002', requestId });
  return { app, session, coordinator, publisher, random, requestRaid, cancelRaid, readStreams, streamers, state, time, errors, post, prepare, spin, raid };
}

describe('authenticated control boundary', () => {
  it.each(['prepare', 'spin', 'raid', 'cancel'])('rejects unauthenticated %s before reading Twitch data', async (action) => {
    const h = setup();
    const response = await h.post(action, {}, { cookie: '' });
    expect(response.statusCode).toBe(401);
    expect(h.readStreams).not.toHaveBeenCalled();
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('never accepts a viewing credential as a control session', async () => {
    const h = setup();
    expect((await h.post('raid', {}, { cookie: 'raidsphere_session=fixture-viewing-credential-only', authorization: 'Bearer fixture-viewing-credential-only' })).statusCode).toBe(401);
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('rejects another source owner, a mismatched session, and invalid input', async () => {
    const h = setup();
    expect((await h.post('raid', { channelId: '9009', toStreamerId: '2002', requestId: randomUUID() })).statusCode).toBe(403);
    expect((await h.post('raid', { channelId: SOURCE, toStreamerId: 'not-an-id', requestId: randomUUID() })).statusCode).toBe(400);
    expect((await h.post('raid', { channelId: SOURCE, toStreamerId: '2002', sessionId: 'forged', requestId: randomUUID() })).statusCode).toBe(400);
    h.session.overlay.channelId = '9009';
    expect((await h.raid()).statusCode).toBe(403);
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('rejects cross-origin actions and missing custom headers', async () => {
    const h = setup();
    expect((await h.post('raid', {}, { origin: 'https://untrusted.example', host: 'localhost' })).statusCode).toBe(403);
    expect((await h.post('raid', {}, { 'x-raidsphere-control': '' })).statusCode).toBe(403);
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('reports offline sources and never submits a raid', async () => {
    const h = setup(); h.state.streams = h.state.streams.filter((entry) => entry.userId !== SOURCE);
    const status = await h.app.inject({ method: 'GET', url: '/api/control/status', headers: { cookie: COOKIE } });
    expect(status.json()).toMatchObject({ isLive: false, viewers: 0, simulated: true });
    const rejected = await h.raid();
    expect(rejected.statusCode).toBe(409); expect(rejected.json().error).toContain('offline');
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
});

describe('manual and automatic candidates', () => {
  it('accepts unregistered live manual destinations and preserves their actual language', async () => {
    const h = setup(); const prepared = await h.prepare();
    expect(prepared.candidates.map((entry: { streamerId: string }) => entry.streamerId)).toEqual(['2002', '2003']);
    expect(prepared.candidates[1].language).toBe('it');
    expect(await h.streamers.findById('2003')).toBeNull();
  });
  it('rejects duplicates, self-selection, missing live channels, and invalid provider data', async () => {
    const h = setup();
    expect((await h.post('prepare', { channelId: SOURCE, mode: 'manual', candidateIds: ['2002', '2002'] })).statusCode).toBe(400);
    expect((await h.post('prepare', { channelId: SOURCE, mode: 'manual', candidateIds: [SOURCE] })).statusCode).toBe(409);
    expect((await h.post('prepare', { channelId: SOURCE, mode: 'manual', candidateIds: ['9009'] })).statusCode).toBe(409);
    h.state.streams[1] = stream('2002', -1);
    expect((await h.post('prepare', { channelId: SOURCE, mode: 'auto', count: 6 })).statusCode).toBe(502);
  });
  it('uses inclusive half-to-double bounds, deduplicates, and reports fewer than six without widening', async () => {
    const h = setup();
    h.state.streams.push(stream('2002', 50), stream('2004', 49), stream('2005', 201));
    h.state.limited = true;
    const response = await h.post('prepare', { channelId: SOURCE, mode: 'auto', count: 7 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sourceViewers: 100, minViewers: 50, maxViewers: 200, discoveryLimited: true });
    expect(response.json().candidates.map((entry: { streamerId: string }) => entry.streamerId)).toEqual(['2002', '2003']);
  });
  it('returns zero eligible candidates without widening configured preferences', async () => {
    const h = setup();
    await h.streamers.save({ ...source, minViewers: 70, maxViewers: 150, acceptsOtherLanguages: false });
    const response = await h.post('prepare', { channelId: SOURCE, mode: 'auto', count: 6 });
    expect(response.json().candidates).toEqual([]);
    const spin = await h.post('spin', { channelId: SOURCE, poolId: response.json().poolId, requestId: randomUUID() });
    expect(spin.statusCode).toBe(409); expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('samples six or seven candidates using the injected random source', () => {
    const pool = Array.from({ length: 10 }, (_, index) => candidate(String(2000 + index), 100));
    const random = { nextInt: vi.fn((max: number) => max - 1) };
    expect(autoCandidates(SOURCE, 100, pool, 6, random)).toHaveLength(6);
    const seven = autoCandidates(SOURCE, 100, pool, 7, random);
    expect(seven).toHaveLength(7); expect(seven[0]?.streamerId).toBe('2009');
    expect(new Set(seven.map((entry) => entry.streamerId)).size).toBe(7);
  });
  it('rechecks changed viewer counts before an auto spin', async () => {
    const h = setup();
    const prepared = await h.post('prepare', { channelId: SOURCE, mode: 'auto', count: 6 });
    h.state.streams[1] = stream('2002', 201);
    const response = await h.post('spin', { channelId: SOURCE, poolId: prepared.json().poolId, requestId: randomUUID() });
    expect(response.statusCode).toBe(409); expect(h.requestRaid).not.toHaveBeenCalled();
  });
});

describe('authoritative browser spins and published OBS events', () => {
  it('chooses on the server, publishes matching language, and never automatically raids', async () => {
    const h = setup(); h.random.nextInt.mockReturnValue(1);
    const events: unknown[] = [];
    const view = await h.coordinator.openView(SOURCE, (event) => { events.push(event); });
    const response = await h.spin();
    expect(response.statusCode).toBe(200);
    expect(response.json().roulette).toMatchObject({ mode: 'manual', status: 'chosen', chosenCandidate: { streamerId: '2003', language: 'it' } });
    const published = events.map((event) => serverEventSchema.parse(event));
    expect(published.map((event) => event.type)).toEqual(['roulette:start', 'roulette:chosen']);
    expect(published[1]).toMatchObject({ channelId: SOURCE, payload: { winningLanguage: 'it', candidate: { streamerId: '2003' } } });
    expect(h.requestRaid).not.toHaveBeenCalled(); expect(h.errors).toEqual([]);
    view?.close();
  });
  it('rejects a client-selected winner and does not allow a foreign pool', async () => {
    const h = setup(); const prepared = await h.prepare();
    expect((await h.post('spin', { channelId: SOURCE, poolId: prepared.poolId, requestId: randomUUID(), winnerId: '2002' })).statusCode).toBe(400);
    expect((await h.post('spin', { channelId: SOURCE, poolId: randomUUID(), requestId: randomUUID() })).statusCode).toBe(409);
    expect(h.requestRaid).not.toHaveBeenCalled();
  });
  it('rejects an expired prepared pool before selecting a winner', async () => {
    const h = setup(); const prepared = await h.prepare();
    vi.spyOn(Date, 'now').mockReturnValue(prepared.expiresAtMs + 1);
    const response = await h.post('spin', { channelId: SOURCE, poolId: prepared.poolId, requestId: randomUUID() });
    expect(response.statusCode).toBe(409); expect(h.random.nextInt).not.toHaveBeenCalled();
  });
});

describe('raid lifecycle and duplicate protection', () => {
  it('queues one explicit raid and confirms only a correlated arrival, without translation for the unregistered target', async () => {
    const h = setup(); const id = randomUUID();
    const [first, duplicate] = await Promise.all([h.raid(id), h.raid(id)]);
    expect(first.json().roulette.status).toBe('raid_pending'); expect(duplicate.json()).toEqual(first.json());
    expect(h.requestRaid).toHaveBeenCalledOnce();
    await h.coordinator.handleArrival({ eventId: 'wrong', fromChannelId: SOURCE, toChannelId: '9009', viewers: 10, observedAtMs: h.time.now() });
    expect((await h.coordinator.snapshot(SOURCE)).roulette?.status).toBe('raid_pending');
    await h.coordinator.handleArrival({ eventId: 'correct', fromChannelId: SOURCE, toChannelId: '2002', viewers: 10, observedAtMs: h.time.now() });
    expect((await h.coordinator.snapshot(SOURCE)).roulette?.status).toBe('done');
    expect(await h.coordinator.translationWindow('2002')).toBeNull();
    expect(await h.streamers.findById('2002')).toBeNull();
  });
  it('requires explicit raid action after a spin and rejects reuse of an action ID for another destination', async () => {
    const h = setup(); const spun = (await h.spin()).json().roulette;
    const payload = { channelId: SOURCE, sessionId: spun.sessionId, requestId: randomUUID() };
    expect((await h.post('raid', payload)).json().roulette.status).toBe('raid_pending');
    expect((await h.post('raid', { ...payload, requestId: randomUUID() })).json().roulette.status).toBe('raid_pending');
    expect(h.requestRaid).toHaveBeenCalledOnce();
    expect((await h.post('raid', { channelId: SOURCE, toStreamerId: '2003', requestId: payload.requestId })).statusCode).toBe(409);
  });
  it.each(['rejected', 'unknown'] as const)('reports a %s gateway outcome without retrying', async (outcome) => {
    const h = setup(); h.state.raid = { outcome };
    const response = await h.raid();
    expect(response.json().roulette.status).toBe(outcome === 'rejected' ? 'failed' : 'unknown');
    expect(h.requestRaid).toHaveBeenCalledOnce();
    if (outcome === 'unknown') expect((await h.raid()).statusCode).toBe(409);
  });
  it('marks a missing arrival uncertain and accepts a late correlated observation within its bounded grace', async () => {
    const h = setup(); await h.raid();
    await h.time.advance(150_000);
    expect((await h.coordinator.snapshot(SOURCE)).roulette?.status).toBe('unknown');
    await h.coordinator.handleArrival({ eventId: 'late', fromChannelId: SOURCE, toChannelId: '2002', viewers: 10, observedAtMs: h.time.now() });
    expect((await h.coordinator.snapshot(SOURCE)).roulette?.status).toBe('done');
    expect(h.requestRaid).toHaveBeenCalledOnce();
  });
  it.each(['cancelled', 'not_cancelled', 'unknown'] as const)('preserves the %s cancellation outcome', async (outcome) => {
    const h = setup(); h.state.cancel = outcome;
    const state = (await h.raid()).json().roulette;
    const response = await h.post('cancel', { channelId: SOURCE, sessionId: state.sessionId, requestId: randomUUID() });
    expect(response.json().roulette.status).toBe(outcome === 'cancelled' ? 'cancelled' : outcome === 'unknown' ? 'unknown' : 'raid_pending');
    expect(h.cancelRaid).toHaveBeenCalledOnce();
  });
  it('supports simulated raids to a destination without registering it', async () => {
    const streamers = new InMemoryStreamerRepository([source]);
    const gateway = new SimulatedRaidGateway({ acceptRate: 1, arrivalRate: 1 });
    const adapter = new RaidGatewayAdapter({ gateway, streamers, onArrival: () => undefined });
    try {
      expect((await adapter.requestRaid({ sessionId: 'simulation-fixture', fromChannelId: SOURCE, toStreamerId: '2002', toLogin: 'channel_2002' })).outcome).toBe('accepted');
      expect(await streamers.findById('2002')).toBeNull();
    } finally { adapter.close(); gateway.dispose(); }
  });
});
