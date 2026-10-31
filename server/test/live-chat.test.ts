import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createRuntime } from '../src/composition.js';
import type { EventSubClient, EventSubClientOptions, EventSubNotification } from '../src/twitch/eventsub.js';
import type { TwitchTokens, TwitchUser } from '../src/twitch/oauth.js';
import { createSession, destroySession, type UserSession } from '../src/twitch/sessions.js';

// A fake client stands in for the WebSocket; all values are test fixtures.
const USER_ID = '1001';
const SCOPES = ['channel:manage:raids', 'user:read:chat', 'user:read:email'];

interface FakeClient extends EventSubClient {
  options: EventSubClientOptions;
  emit(notification: EventSubNotification): void;
  stop: Mock<() => void>;
  watching: string[];
}

function fakeFactory(): { clients: FakeClient[]; create: (options: EventSubClientOptions) => EventSubClient } {
  const clients: FakeClient[] = [];
  return {
    clients,
    create: (options) => {
      const watching: string[] = [];
      const client: FakeClient = {
        options, watching,
        start: () => undefined,
        stop: vi.fn<() => void>(),
        status: () => 'connected',
        watchChat: async (channelId) => { watching.push(channelId); return true; },
        unwatchChat: async () => undefined,
        isWatchingChat: (channelId) => watching.includes(channelId),
        emit: (notification) => { options.onNotification(notification); },
      };
      clients.push(client);
      return client;
    },
  };
}

const tokens = (scope: string[] = SCOPES): TwitchTokens => ({
  access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, scope,
});

const user = (id = USER_ID): TwitchUser => ({
  id, login: `user_${id}`, display_name: `User ${id}`, profile_image_url: 'https://example.com/a.png',
  broadcaster_type: '', description: '', created_at: '2026-10-31T00:00:00Z',
});

const open = (scope?: string[]): UserSession => createSession(
  `session-${USER_ID}`, user(), tokens(scope), { channelId: USER_ID, viewingCredential: 'fixture' },
);

let sequence = 0;

const chat = (text: string, chatter: { id: string; badge?: string } = { id: '3003' }, extra: Record<string, unknown> = {}): EventSubNotification => {
  sequence += 1;
  return {
    eventId: `event-${sequence}`, receivedAtMs: Date.now(), type: 'channel.chat.message',
    event: {
      broadcaster_user_id: USER_ID, broadcaster_user_login: 'origin', broadcaster_user_name: 'Origin',
      chatter_user_id: chatter.id, chatter_user_login: 'chatter', chatter_user_name: 'Chatter',
      message_id: `chat-${sequence}`, message: { text, fragments: [{ type: 'text', text }] },
      color: '', badges: chatter.badge ? [{ set_id: chatter.badge, id: '1', info: '' }] : [],
      ...extra,
    },
  };
};

const OWNER = { id: USER_ID, badge: 'broadcaster' };

describe('live chat', () => {
  let factory: ReturnType<typeof fakeFactory>;
  let runtime: ReturnType<typeof createRuntime>;
  let errors: string[];

  const start = (channelLanguage: () => Promise<string | null> = async () => 'es'): void => {
    runtime = createRuntime({
      reportError: (message) => { errors.push(message); },
      liveChat: { createClient: factory.create, channelLanguage },
    });
  };

  beforeEach(() => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'fixture-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    factory = fakeFactory();
    errors = [];
  });

  afterEach(async () => {
    await runtime.app.close();
    destroySession(`session-${USER_ID}`);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('opens a client for the channel of the user who logged in', async () => {
    start();
    await runtime.liveChat?.connect(open());
    expect(factory.clients).toHaveLength(1);
    expect(factory.clients[0]?.options).toMatchObject({ clientId: 'fixture-client', userId: USER_ID });
    expect(factory.clients[0]?.watching).toEqual([USER_ID]);
    expect(runtime.liveChat?.state(USER_ID)).toBe('ready');
  });

  it('does not open a client without the chat scope', async () => {
    start();
    await runtime.liveChat?.connect(open(['user:read:email']));
    expect(factory.clients).toHaveLength(0);
    expect(runtime.liveChat?.state(USER_ID)).toBe('offline');
    expect(errors).toContain('Twitch chat needs a new login with the required permissions.');
  });

  it('starts a roulette from the broadcaster, with votes from viewers', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;

    client.emit(chat('!roulette', OWNER));
    await vi.waitFor(async () => {
      expect((await runtime.coordinator.snapshot(USER_ID)).roulette?.status).toBe('voting');
    });

    const language = (await runtime.coordinator.snapshot(USER_ID)).roulette?.candidates[0]?.language;
    client.emit(chat(`!vote ${language}`));
    await vi.waitFor(async () => {
      expect((await runtime.coordinator.snapshot(USER_ID)).roulette?.votes[language as 'es']).toBe(1);
    });
  });

  it('ignores control commands from viewers', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;

    client.emit(chat('!roulette'));
    client.emit(chat('!roulette', { id: '3004', badge: 'broadcaster' }));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect((await runtime.coordinator.snapshot(USER_ID)).roulette).toBeNull();
  });

  it('ignores commands shared from another channel', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;

    client.emit(chat('!roulette', { id: '3003', badge: 'moderator' }, { source_broadcaster_user_id: '9009' }));
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect((await runtime.coordinator.snapshot(USER_ID)).roulette).toBeNull();
  });

  it('forwards chat and moderation to the translation pipeline', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;
    const handleMessage = vi.spyOn(runtime.chatMessages, 'handleMessage');
    const handleModeration = vi.spyOn(runtime.chatMessages, 'handleModeration');

    client.emit(chat('hola a todos'));
    client.emit({
      eventId: 'moderation-1', receivedAtMs: 1, type: 'channel.chat.clear',
      event: { broadcaster_user_id: USER_ID, broadcaster_user_login: 'origin', broadcaster_user_name: 'Origin' },
    });

    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: USER_ID, text: 'hola a todos', sourceLanguage: null,
    }));
    expect(handleModeration).toHaveBeenCalledWith({ type: 'chat_cleared', channelId: USER_ID });
  });

  it('skips chat events that belong to another channel or carry no text', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;
    const handleMessage = vi.spyOn(runtime.chatMessages, 'handleMessage');

    client.emit(chat('hola', { id: '3003' }, { broadcaster_user_id: '9009' }));
    client.emit(chat('   '));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('forwards raid events as arrivals', async () => {
    start();
    await runtime.liveChat?.connect(open());
    const client = factory.clients[0] as FakeClient;
    const handleArrival = vi.spyOn(runtime.coordinator, 'handleArrival');

    client.emit({
      eventId: 'raid-1', receivedAtMs: 5_000, type: 'channel.raid',
      event: {
        from_broadcaster_user_id: USER_ID, from_broadcaster_user_login: 'origin', from_broadcaster_user_name: 'Origin',
        to_broadcaster_user_id: '2002', to_broadcaster_user_login: 'target', to_broadcaster_user_name: 'Target',
        viewers: 42,
      },
    });

    expect(handleArrival).toHaveBeenCalledWith({
      eventId: 'raid-1', fromChannelId: USER_ID, toChannelId: '2002', viewers: 42, observedAtMs: 5_000,
    });
  });

  it('registers the streamer with the Twitch language and keeps earlier data on a new login', async () => {
    start();
    await runtime.liveChat?.connect(open());
    await runtime.liveChat?.connect(open());
    expect(factory.clients).toHaveLength(2);
    expect(factory.clients[0]?.stop).toHaveBeenCalledOnce();

    factory.clients[1]?.emit(chat('!roulette', OWNER));
    await vi.waitFor(async () => {
      expect((await runtime.coordinator.snapshot(USER_ID)).roulette?.status).toBe('voting');
    });
  });

  it('still connects when the channel language cannot be read', async () => {
    start(async () => { throw new Error('fixture failure'); });
    await expect(runtime.liveChat?.connect(open())).resolves.toBeUndefined();
    expect(factory.clients).toHaveLength(1);
  });

  it('stops the client on logout and on shutdown', async () => {
    start();
    await runtime.liveChat?.connect(open());
    runtime.liveChat?.disconnect(USER_ID);
    expect(factory.clients[0]?.stop).toHaveBeenCalledOnce();
    expect(runtime.liveChat?.state(USER_ID)).toBe('offline');

    await runtime.liveChat?.connect(open());
    await runtime.app.close();
    expect(factory.clients[1]?.stop).toHaveBeenCalledOnce();
    runtime = createRuntime({ reportError: () => undefined });
  });

  it('limits how many channels hold a connection', async () => {
    runtime = createRuntime({
      reportError: (message) => { errors.push(message); },
      liveChat: { createClient: factory.create, channelLanguage: async () => 'es', maxConnections: 1 },
    });
    await runtime.liveChat?.connect(open());
    const other = createSession('session-2002', user('2002'), tokens(), { channelId: '2002', viewingCredential: 'fixture' });
    await runtime.liveChat?.connect(other);
    destroySession('session-2002');

    expect(factory.clients).toHaveLength(1);
    expect(errors).toContain('Twitch chat could not connect because the server is at capacity.');
  });

  it('reports the state on the dashboard and in /auth/me', async () => {
    start();
    const session = open();
    await runtime.liveChat?.connect(session);
    const cookie = `raidsphere_session=${session.sessionId}`;

    const dashboard = await runtime.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(dashboard.body).toContain('Listening to your Twitch chat.');
    const me = await runtime.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().capabilities.eventSub).toBe(true);
  });
});

describe('live chat disabled', () => {
  it('keeps the current behavior by default', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const runtime = createRuntime({ reportError: () => undefined });
    const session = createSession('session-off', user('5005'), tokens(), { channelId: '5005', viewingCredential: 'fixture' });
    try {
      const cookie = `raidsphere_session=${session.sessionId}`;
      expect(runtime.liveChat).toBeNull();
      const dashboard = await runtime.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
      expect(dashboard.body).toContain('runtime subscription is not enabled yet');
      const me = await runtime.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
      expect(me.json().capabilities.eventSub).toBe(false);
    } finally {
      destroySession('session-off');
      await runtime.app.close();
      vi.restoreAllMocks();
    }
  });
});
