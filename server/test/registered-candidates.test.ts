import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Streamer } from '@raidsphere/shared';
import { createRuntime } from '../src/composition.js';
import type { EventSubClient, EventSubClientOptions, EventSubNotification } from '../src/twitch/eventsub.js';
import type { Stream } from '../src/twitch/helix.js';
import type { TwitchTokens, TwitchUser } from '../src/twitch/oauth.js';
import { RegisteredCandidateSource } from '../src/twitch/registered-candidates.js';
import { createSession, destroySession, type UserSession } from '../src/twitch/sessions.js';

// A fake client and fake streams stand in for Twitch; all values are test fixtures.
const SCOPES = ['channel:manage:raids', 'user:read:chat', 'user:read:email'];

const streamer = (id: string, overrides: Partial<Streamer> = {}): Streamer => ({
  id, login: `user_${id}`, displayName: `User ${id}`, avatarUrl: 'https://example.com/a.png', language: 'es',
  minViewers: 0, maxViewers: 1_000, acceptsOtherLanguages: true, reputation: 0, ...overrides,
});

const stream = (userId: string, overrides: Partial<Stream> = {}): Stream => ({
  id: `stream-${userId}`, userId, userLogin: `user_${userId}`, userName: `User ${userId}`, gameId: '1',
  gameName: 'Just Chatting', type: 'live', title: 'Live now', viewerCount: 25, startedAt: '2026-10-31T00:00:00Z',
  language: 'es', thumbnailUrl: '', tags: [], isMature: false, ...overrides,
});

describe('registered candidate source', () => {
  const repository = (known: readonly Streamer[]) => ({
    findById: async (id: string) => known.find((item) => item.id === id) ?? null,
  });

  it('lists connected channels that are live, with their stream data', async () => {
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002', '3003'], streamers: repository([streamer('2002'), streamer('3003')]),
      fetchStreams: async () => [stream('2002')], reportError: () => undefined,
    });

    await expect(source.listLiveChannels()).resolves.toEqual([{
      streamer: streamer('2002'), viewers: 25, gameName: 'Just Chatting', title: 'Live now', illustrativeCountry: 'MX',
    }]);
  });

  it('uses the current stream language, or the stored one when it is unsupported', async () => {
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002', '3003'],
      streamers: repository([streamer('2002', { language: 'en' }), streamer('3003', { language: 'en' })]),
      fetchStreams: async () => [stream('2002', { language: 'es' }), stream('3003', { language: 'ru' })],
      reportError: () => undefined,
    });

    const channels = await source.listLiveChannels();
    expect(channels.map((channel) => [channel.streamer.id, channel.streamer.language, channel.illustrativeCountry]))
      .toEqual([['2002', 'es', 'MX'], ['3003', 'en', expect.any(String)]]);
  });

  it('asks only for connected channels', async () => {
    const fetchStreams = vi.fn(async () => []);
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002', '3003'], streamers: repository([]), fetchStreams, reportError: () => undefined,
    });
    await source.listLiveChannels();
    expect(fetchStreams).toHaveBeenCalledWith(['2002', '3003']);
  });

  // Get Streams with no user filter returns the top streams on all of Twitch.
  it('makes no request when no channel is connected', async () => {
    const fetchStreams = vi.fn(async () => [stream('9009')]);
    const source = new RegisteredCandidateSource({
      connectedChannels: () => [], streamers: repository([]), fetchStreams, reportError: () => undefined,
    });
    await expect(source.listLiveChannels()).resolves.toEqual([]);
    expect(fetchStreams).not.toHaveBeenCalled();
  });

  it('ignores streams that are not live or not registered', async () => {
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002', '3003'], streamers: repository([streamer('2002')]),
      fetchStreams: async () => [stream('2002', { type: '' }), stream('3003'), stream('9009')],
      reportError: () => undefined,
    });
    await expect(source.listLiveChannels()).resolves.toEqual([]);
  });

  it('reports a Twitch failure without exposing it, and offers no candidates', async () => {
    const errors: string[] = [];
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002'], streamers: repository([streamer('2002')]),
      fetchStreams: async () => { throw new Error('internal upstream detail'); },
      reportError: (message) => { errors.push(message); },
    });
    await expect(source.listLiveChannels()).resolves.toEqual([]);
    expect(errors).toEqual(['Live channels could not be read from Twitch.']);
  });

  it('gives up on a request that never answers', async () => {
    const errors: string[] = [];
    const source = new RegisteredCandidateSource({
      connectedChannels: () => ['2002'], streamers: repository([streamer('2002')]),
      fetchStreams: () => new Promise(() => undefined), timeoutMs: 5,
      reportError: (message) => { errors.push(message); },
    });
    await expect(source.listLiveChannels()).resolves.toEqual([]);
    expect(errors).toEqual(['Live channels could not be read from Twitch.']);
  });
});

function fakeFactory(): { clients: Map<string, EventSubClient & { emit(n: EventSubNotification): void }>; create: (options: EventSubClientOptions) => EventSubClient } {
  const clients = new Map<string, EventSubClient & { emit(n: EventSubNotification): void }>();
  return {
    clients,
    create: (options) => {
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
  access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, scope: SCOPES,
});

const user = (id: string): TwitchUser => ({
  id, login: `user_${id}`, display_name: `User ${id}`, profile_image_url: 'https://example.com/a.png',
  broadcaster_type: '', description: '', created_at: '2026-10-31T00:00:00Z',
});

const login = (id: string): UserSession => createSession(`session-${id}`, user(id), tokens(), { channelId: id, viewingCredential: 'fixture' });

let sequence = 0;
const rouletteFrom = (id: string): EventSubNotification => {
  sequence += 1;
  return {
    eventId: `event-${sequence}`, receivedAtMs: Date.now(), type: 'channel.chat.message',
    event: {
      broadcaster_user_id: id, broadcaster_user_login: `user_${id}`, broadcaster_user_name: `User ${id}`,
      chatter_user_id: id, chatter_user_login: `user_${id}`, chatter_user_name: `User ${id}`,
      message_id: `chat-${sequence}`, message: { text: '!roulette', fragments: [] },
      color: '', badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
    },
  };
};

describe('roulette with registered channels', () => {
  let factory: ReturnType<typeof fakeFactory>;
  let runtime: ReturnType<typeof createRuntime>;
  let live: string[];

  const start = (): void => {
    runtime = createRuntime({
      reportError: () => undefined,
      roulette: { votingDurationMs: 20, voteBroadcastIntervalMs: 5 },
      simulatedRaid: { acceptRate: 1, arrivalRate: 1, minCountdownMs: 5, maxCountdownMs: 5, observationTimeoutMs: 1_000 },
      liveChat: { createClient: factory.create, channelLanguage: async () => 'es' },
      realCandidates: { fetchStreams: async (ids) => live.filter((id) => ids.includes(id)).map((id) => stream(id)) },
    });
  };

  beforeEach(() => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'fixture-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    factory = fakeFactory();
    live = [];
  });

  afterEach(async () => {
    await runtime.app.close();
    destroySession('session-1001');
    destroySession('session-2002');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('offers only live registered channels, never synthetic ones or the source', async () => {
    start();
    await runtime.liveChat?.connect(login('1001'));
    await runtime.liveChat?.connect(login('2002'));
    live = ['1001', '2002'];

    factory.clients.get('1001')?.emit(rouletteFrom('1001'));
    await vi.waitFor(async () => {
      const { roulette } = await runtime.coordinator.snapshot('1001');
      expect(roulette?.candidates.map((candidate) => candidate.streamerId)).toEqual(['2002']);
    });
  });

  it('starts no roulette when no other registered channel is live', async () => {
    start();
    await runtime.liveChat?.connect(login('1001'));
    await runtime.liveChat?.connect(login('2002'));
    live = ['1001'];

    factory.clients.get('1001')?.emit(rouletteFrom('1001'));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect((await runtime.coordinator.snapshot('1001')).roulette).toBeNull();
  });

  it('stops offering a channel after logout', async () => {
    start();
    await runtime.liveChat?.connect(login('1001'));
    await runtime.liveChat?.connect(login('2002'));
    runtime.liveChat?.disconnect('2002');
    live = ['1001', '2002'];

    factory.clients.get('1001')?.emit(rouletteFrom('1001'));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect((await runtime.coordinator.snapshot('1001')).roulette).toBeNull();
  });

  it('opens the translation window on the real destination after the simulated raid', async () => {
    start();
    await runtime.liveChat?.connect(login('1001'));
    await runtime.liveChat?.connect(login('2002'));
    live = ['1001', '2002'];

    factory.clients.get('1001')?.emit(rouletteFrom('1001'));

    await vi.waitFor(async () => {
      expect((await runtime.coordinator.translationWindow('2002'))?.status).toBe('active');
    }, { timeout: 2_000 });
  });
});

describe('real candidates disabled', () => {
  it('keeps synthetic candidates with live chat alone', async () => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'fixture-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const factory = fakeFactory();
    const runtime = createRuntime({
      reportError: () => undefined,
      liveChat: { createClient: factory.create, channelLanguage: async () => 'es' },
    });
    try {
      await runtime.liveChat?.connect(login('1001'));
      factory.clients.get('1001')?.emit(rouletteFrom('1001'));
      await vi.waitFor(async () => {
        const { roulette } = await runtime.coordinator.snapshot('1001');
        expect(roulette?.candidates[0]?.streamerId).toMatch(/^rsdemo_/);
      });
    } finally {
      await runtime.app.close();
      destroySession('session-1001');
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
