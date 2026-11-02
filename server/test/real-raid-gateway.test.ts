import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/composition.js';
import type { EventSubClient, EventSubClientOptions, EventSubNotification } from '../src/twitch/eventsub.js';
import { cancelRaid, HelixError, RateLimitError, startRaid } from '../src/twitch/helix.js';
import type { Stream } from '../src/twitch/helix.js';
import type { TwitchTokens, TwitchUser } from '../src/twitch/oauth.js';
import { RealRaidGateway, type RealRaidGatewayDependencies } from '../src/twitch/real-raid-gateway.js';
import { createSession, destroySession, type UserSession } from '../src/twitch/sessions.js';

// No request reaches Twitch: every call goes to a fake. All values are test fixtures.
const REQUEST = { sessionId: 'session-1', fromChannelId: '1001', toStreamerId: '2002' };
const CANCEL = { sessionId: 'session-1', fromChannelId: '1001' };

const gateway = (overrides: Partial<RealRaidGatewayDependencies> = {}) => {
  const errors: string[] = [];
  const start = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const instance = new RealRaidGateway({
    clientId: () => 'fixture-client',
    tokenProvider: () => async ({ forceRefresh }) => (forceRefresh ? 'fresh-token' : 'fixture-token'),
    clock: { now: () => 5_000 },
    reportError: (message) => { errors.push(message); },
    start, cancel, ...overrides,
  });
  return { instance, errors, start, cancel };
};

describe('real raid gateway', () => {
  it('starts the raid with the token of the source channel', async () => {
    const { instance, start } = gateway();

    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({
      outcome: 'accepted', requestedAtMs: 5_000, estimatedCountdownSeconds: 90,
    });

    expect(start).toHaveBeenCalledWith('1001', '2002', { accessToken: 'fixture-token', clientId: 'fixture-client' });
  });

  it('treats the session id as an idempotency key', async () => {
    const { instance, start } = gateway();
    const [first, second] = await Promise.all([instance.requestRaid(REQUEST), instance.requestRaid(REQUEST)]);
    expect(second).toEqual(first);
    expect(start).toHaveBeenCalledOnce();
  });

  it('refuses channels that are not real Twitch ids', async () => {
    const { instance, start } = gateway();
    await expect(instance.requestRaid({ ...REQUEST, toStreamerId: 'rsdemo_es_01' })).resolves.toEqual({ outcome: 'rejected' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects when the source channel has no connected session', async () => {
    const { instance, start } = gateway({ tokenProvider: () => null });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'rejected' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects when no token can be obtained', async () => {
    const { instance, start } = gateway({ tokenProvider: () => async () => { throw new Error('fixture failure'); } });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'rejected' });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([[400], [404], [409]])('rejects when Twitch answers %i', async (status) => {
    const { instance, errors } = gateway({ start: vi.fn(async () => { throw new HelixError('private detail', status); }) });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'rejected' });
    // Only the status code reaches the log, never Twitch's message.
    expect(errors).toEqual([`Twitch refused a raid request (HTTP ${status}).`]);
  });

  it('rejects when Twitch limits the request, since it never started', async () => {
    const { instance } = gateway({ start: vi.fn(async () => { throw new RateLimitError('private detail', 1_000); }) });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'rejected' });
  });

  it.each([
    ['a server error', new HelixError('private detail', 503)],
    ['a network failure', new TypeError('private detail')],
    ['a timeout', new DOMException('private detail', 'TimeoutError')],
    // Twitch accepted the call, so the raid may be running even with an unreadable answer.
    ['an unreadable success', new HelixError('private detail', 200)],
  ])('reports the outcome as unknown after %s', async (_name, failure) => {
    const { instance, errors } = gateway({ start: vi.fn(async () => { throw failure; }) });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'unknown' });
    expect(errors.join(' ')).not.toContain('private detail');
  });

  it('refreshes the token once after a 401 response', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new HelixError('expired', 401))
      .mockResolvedValueOnce(undefined);
    const { instance } = gateway({ start });

    await expect(instance.requestRaid(REQUEST)).resolves.toMatchObject({ outcome: 'accepted' });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith('1001', '2002', { accessToken: 'fresh-token', clientId: 'fixture-client' });
  });

  it('rejects when the refreshed token is refused too', async () => {
    const start = vi.fn(async () => { throw new HelixError('expired', 401); });
    const { instance } = gateway({ start });
    await expect(instance.requestRaid(REQUEST)).resolves.toEqual({ outcome: 'rejected' });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('cancels a raid it started', async () => {
    const { instance, cancel } = gateway();
    await instance.requestRaid(REQUEST);

    await expect(instance.cancelRaid(CANCEL)).resolves.toBe('cancelled');

    expect(cancel).toHaveBeenCalledWith('1001', { accessToken: 'fixture-token', clientId: 'fixture-client' });
  });

  it('never cancels a raid it did not start', async () => {
    const { instance, cancel } = gateway();
    await expect(instance.cancelRaid(CANCEL)).resolves.toBe('not_cancelled');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reports that a raid could not be cancelled when Twitch has none pending', async () => {
    const { instance } = gateway({ cancel: vi.fn(async () => { throw new HelixError('no raid', 404); }) });
    await instance.requestRaid(REQUEST);
    await expect(instance.cancelRaid(CANCEL)).resolves.toBe('not_cancelled');
  });

  it('reports the cancellation as unknown after a server or network failure', async () => {
    const { instance } = gateway({ cancel: vi.fn(async () => { throw new TypeError('private detail'); }) });
    await instance.requestRaid(REQUEST);
    await expect(instance.cancelRaid(CANCEL)).resolves.toBe('unknown');
  });
});

describe('Helix raid requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const CONFIG = { accessToken: 'fixture-token', clientId: 'fixture-client' };

  // A delayed retry could start a raid after the session was already reported as unknown.
  it('never retries a limited raid request', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startRaid('1001', '2002', CONFIG)).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never retries a limited cancellation, and bounds both calls', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelRaid('1001', CONFIG)).rejects.toBeInstanceOf(RateLimitError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

function fakeFactory() {
  const clients = new Map<string, EventSubClient & { emit(n: EventSubNotification): void }>();
  return {
    clients,
    create: (options: EventSubClientOptions): EventSubClient => {
      const watching = new Set<string>();
      const client = {
        start: () => undefined, stop: () => undefined, status: () => 'connected' as const,
        watchChat: async (channelId: string) => { watching.add(channelId); return true; },
        unwatchChat: async () => undefined,
        isWatchingChat: (channelId: string) => watching.has(channelId),
        emit: (notification: EventSubNotification) => { options.onNotification(notification); },
      };
      clients.set(options.userId, client);
      return client;
    },
  };
}

const tokens = (): TwitchTokens => ({
  access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600,
  scope: ['channel:manage:raids', 'user:read:chat', 'user:read:email'],
});

const user = (id: string): TwitchUser => ({
  id, login: `user_${id}`, display_name: `User ${id}`, profile_image_url: 'https://example.com/a.png',
  broadcaster_type: '', description: '', created_at: '2026-10-31T00:00:00Z',
});

const login = (id: string): UserSession => createSession(`session-${id}`, user(id), tokens(), { channelId: id, viewingCredential: 'fixture' });

const stream = (userId: string): Stream => ({
  id: `stream-${userId}`, userId, userLogin: `user_${userId}`, userName: `User ${userId}`, gameId: '1',
  gameName: 'Just Chatting', type: 'live', title: 'Live now', viewerCount: 25, startedAt: '2026-10-31T00:00:00Z',
  language: 'es', thumbnailUrl: '', tags: [], isMature: false,
});

const roulette = (id: string): EventSubNotification => ({
  eventId: `event-${id}`, receivedAtMs: Date.now(), type: 'channel.chat.message',
  event: {
    broadcaster_user_id: id, broadcaster_user_login: `user_${id}`, broadcaster_user_name: `User ${id}`,
    chatter_user_id: id, chatter_user_login: `user_${id}`, chatter_user_name: `User ${id}`,
    message_id: `chat-${id}`, message: { text: '!roulette', fragments: [] },
    color: '', badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
  },
});

const raidEvent = (eventId: string, to: string): EventSubNotification => ({
  eventId, receivedAtMs: Date.now(), type: 'channel.raid',
  event: {
    from_broadcaster_user_id: '1001', from_broadcaster_user_login: 'user_1001', from_broadcaster_user_name: 'User 1001',
    to_broadcaster_user_id: to, to_broadcaster_user_login: `user_${to}`, to_broadcaster_user_name: `User ${to}`,
    viewers: 42,
  },
});

describe('roulette with real raids', () => {
  let factory: ReturnType<typeof fakeFactory>;
  let runtime: ReturnType<typeof createRuntime>;
  const errors: string[] = [];

  const stubEnvironment = (): void => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'fixture-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    factory = fakeFactory();
    errors.length = 0;
  };

  const start = (raids: { start: NonNullable<RealRaidGatewayDependencies['start']> }): void => {
    stubEnvironment();
    runtime = createRuntime({
      reportError: (message) => { errors.push(message); },
      roulette: { votingDurationMs: 20, voteBroadcastIntervalMs: 5 },
      liveChat: { createClient: factory.create, channelLanguage: async () => 'es' },
      realCandidates: { fetchStreams: async (ids) => ids.map(stream) },
      realRaids: raids,
    });
  };

  afterEach(async () => {
    await runtime.app.close();
    destroySession('session-1001');
    destroySession('session-2002');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const startRoulette = async (): Promise<void> => {
    await runtime.liveChat?.connect(login('1001'));
    await runtime.liveChat?.connect(login('2002'));
    factory.clients.get('1001')?.emit(roulette('1001'));
  };

  const status = async (): Promise<string | undefined> => (await runtime.coordinator.snapshot('1001')).roulette?.status;

  it('sends the raid to Twitch and waits for the observed arrival', async () => {
    const startFake = vi.fn(async () => undefined);
    start({ start: startFake });
    await startRoulette();

    await vi.waitFor(async () => { expect(await status()).toBe('raid_pending'); });
    expect(startFake).toHaveBeenCalledWith('1001', '2002', { accessToken: 'fixture-access', clientId: 'fixture-client' });

    factory.clients.get('1001')?.emit(raidEvent('raid-1', '2002'));

    await vi.waitFor(async () => { expect(await status()).toBe('done'); });
    await vi.waitFor(async () => {
      expect((await runtime.coordinator.translationWindow('2002'))?.status).toBe('active');
    });
  });

  it('does not count a raid to another channel as the arrival', async () => {
    start({ start: vi.fn(async () => undefined) });
    await startRoulette();
    await vi.waitFor(async () => { expect(await status()).toBe('raid_pending'); });

    factory.clients.get('1001')?.emit(raidEvent('raid-1', '9009'));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(await status()).toBe('raid_pending');
  });

  it('fails the session when Twitch rejects the raid', async () => {
    start({ start: vi.fn(async () => { throw new HelixError('private detail', 400); }) });
    await startRoulette();
    await vi.waitFor(async () => { expect(await status()).toBe('failed'); });
  });

  it('marks the session unknown when the request has no clear answer', async () => {
    start({ start: vi.fn(async () => { throw new TypeError('private detail'); }) });
    await startRoulette();
    await vi.waitFor(async () => { expect(await status()).toBe('unknown'); });
  });

  it('reports live mode and real raids', async () => {
    start({ start: vi.fn(async () => undefined) });
    const session = login('1001');
    await runtime.liveChat?.connect(session);
    const cookie = `raidsphere_session=${session.sessionId}`;

    const health = await runtime.app.inject({ method: 'GET', url: '/health' });
    // Real raids do not make translation real.
    expect(health.json()).toMatchObject({ mode: 'live', translation: 'simulated' });
    const me = await runtime.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().capabilities.realRaids).toBe(true);
    const dashboard = await runtime.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(dashboard.body).toContain('Raids are sent to Twitch.');
  });

  it('stays simulated without real candidates', async () => {
    stubEnvironment();
    runtime = createRuntime({
      reportError: (message) => { errors.push(message); },
      liveChat: { createClient: factory.create, channelLanguage: async () => 'es' },
      realRaids: {},
    });
    const health = await runtime.app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ mode: 'simulation' });
    expect(errors).toContain('Real raids stay off: they need real chat and real candidates.');
  });
});
