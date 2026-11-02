import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/composition.js';
import { createSession, destroySession, getSession } from '../src/twitch/sessions.js';
import { candidateSchema, streamerSchema } from '@raidsphere/shared';
import type { TwitchTokens, TwitchUser } from '../src/twitch/oauth.js';

const temporaryRoots: string[] = [];

async function overlayFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'raidsphere-overlay-'));
  temporaryRoots.push(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>RaidSphere Overlay</title>', 'utf8');
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, 'textures'));
  await writeFile(join(root, 'textures', 'earth-night.jpg'), 'fixture', 'utf8');
  return root;
}

const user: TwitchUser = {
  id: '123456789',
  login: 'themask957',
  display_name: 'TheMask957',
  profile_image_url: 'https://example.invalid/avatar.png',
  broadcaster_type: '',
  description: '',
  created_at: '2026-01-01T00:00:00Z',
};

const tokens: TwitchTokens = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  scope: ['channel:manage:raids', 'user:read:chat'],
};

describe('authenticated logout', () => {
  const runtimes: Array<ReturnType<typeof createRuntime>> = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.app.close();
    vi.restoreAllMocks();
  });
  function setup() {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubEnv('TWITCH_CLIENT_ID', 'logout-fixture-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'logout-fixture-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'https://localhost/auth/callback');
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // Construction does not start EventSub; only the existing disconnect hook is exercised.
    const runtime = createRuntime({ reportError: () => undefined, liveChat: { channelLanguage: async () => 'en' } });
    runtimes.push(runtime);
    if (!runtime.liveChat) throw new Error('Expected the logout integration fixture.');
    const disconnect = vi.spyOn(runtime.liveChat, 'disconnect');
    const session = createSession('test-session', user, tokens, { channelId: user.id, viewingCredential: 'x'.repeat(43) });
    const headers = { host: 'localhost', cookie: 'raidsphere_session=test-session', origin: 'https://localhost', 'x-raidsphere-control': '1' };
    const logout = (overrides: Record<string, string> = {}, payload: Record<string, unknown> = {}) => runtime.app.inject({
      method: 'POST', url: '/auth/logout', headers: { ...headers, ...overrides }, payload,
    });
    return { runtime, fetchMock, session, disconnect, headers, logout };
  }

  it('rejects missing or viewing-only credentials and never offers GET logout', async () => {
    const h = setup();
    expect((await h.logout({ cookie: '' })).statusCode).toBe(401);
    expect((await h.logout({ cookie: `raidsphere_session=${'x'.repeat(43)}` })).statusCode).toBe(401);
    expect((await h.runtime.app.inject({ method: 'GET', url: '/auth/logout', headers: h.headers })).statusCode).toBe(404);
    expect(getSession('test-session')).not.toBeNull();
    expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.disconnect).not.toHaveBeenCalled();
  });

  const rejectedLogoutHeaders: Record<string, string>[] = [
    { origin: 'https://untrusted.invalid' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-raidsphere-control': '' },
  ];
  it.each(rejectedLogoutHeaders)('rejects CSRF/origin input %j before any session mutation', async (headers) => {
    const h = setup();
    expect((await h.logout(headers)).statusCode).toBe(403);
    expect(getSession('test-session')).not.toBeNull();
    expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('rejects another identity in the body or a mismatched stored owner', async () => {
    const h = setup();
    expect((await h.logout({}, { channelId: '987654321' })).statusCode).toBe(400);
    h.session.overlay.channelId = '987654321';
    expect((await h.logout()).statusCode).toBe(403);
    expect(getSession('test-session')).not.toBeNull(); expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates local authority, expires the protected cookie, and rejects all subsequent controls', async () => {
    const h = setup();
    const response = await h.logout();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'Logged out', authenticated: false, integrationCleanup: 'confirmed', twitchRevocation: 'confirmed' });
    expect(response.headers['cache-control']).toBe('no-store');
    const expired = String(response.headers['set-cookie']);
    for (const attribute of ['raidsphere_session=;', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) expect(expired).toContain(attribute);
    expect(expired).not.toContain('test-session');
    expect(getSession('test-session')).toBeNull();
    expect(h.disconnect).toHaveBeenCalledOnce(); expect(h.disconnect).toHaveBeenCalledWith(user.id);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://id.twitch.tv/oauth2/revoke');
    expect(String(url)).not.toContain(tokens.access_token);
    expect(init).toMatchObject({ method: 'POST' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(String(init?.body)).get('token')).toBe(tokens.access_token);
    for (const action of ['prepare', 'spin', 'raid', 'cancel']) {
      const protectedRequest = await h.runtime.app.inject({ method: 'POST', url: `/api/control/${action}`, headers: h.headers, payload: {} });
      expect(protectedRequest.statusCode).toBe(401);
    }
    expect((await h.runtime.app.inject({ method: 'GET', url: '/auth/me', headers: h.headers })).statusCode).toBe(401);
    expect((await h.runtime.app.inject({ method: 'GET', url: '/auth/status', headers: h.headers })).json()).toEqual({ authenticated: false });
  });

  it.each(['server-error', 'network-error'] as const)('keeps local logout final after a Twitch %s', async (failure) => {
    const h = setup();
    if (failure === 'server-error') h.fetchMock.mockResolvedValue(new Response('upstream-private-detail', { status: 503 }));
    else h.fetchMock.mockRejectedValue(new TypeError('upstream-private-detail'));
    const response = await h.logout();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: false, twitchRevocation: 'unconfirmed' });
    expect(getSession('test-session')).toBeNull();
    expect(h.fetchMock).toHaveBeenCalledOnce();
    for (const privateValue of [tokens.access_token, tokens.refresh_token, 'logout-fixture-secret', 'upstream-private-detail']) expect(response.body).not.toContain(privateValue);
  });

  it('still revokes the token and destroys the session when integration cleanup fails', async () => {
    const h = setup(); h.disconnect.mockImplementation(() => { throw new Error('private-cleanup-detail'); });
    const response = await h.logout();
    expect(response.json()).toMatchObject({ authenticated: false, integrationCleanup: 'unconfirmed', twitchRevocation: 'confirmed' });
    expect(getSession('test-session')).toBeNull(); expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(response.body).not.toContain('private-cleanup-detail');
  });

  it('uses an eight-second abort deadline and never restores the session after an upstream timeout', async () => {
    const h = setup(); const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    h.fetchMock.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) { reject(new Error('Expected a revocation deadline.')); return; }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = h.logout();
    await vi.waitFor(() => { expect(h.fetchMock).toHaveBeenCalledOnce(); });
    expect(getSession('test-session')).toBeNull();
    expect(timeout).toHaveBeenCalledWith(8_000);
    deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
    const response = await pending;
    expect(response.json()).toMatchObject({ authenticated: false, twitchRevocation: 'unconfirmed' });
    expect(getSession('test-session')).toBeNull(); expect(h.fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate while the first revocation is still in flight', async () => {
    const h = setup();
    let finish: ((response: Response) => void) | undefined;
    h.fetchMock.mockImplementation(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    const first = h.logout();
    await vi.waitFor(() => { expect(h.fetchMock).toHaveBeenCalledOnce(); });
    expect((await h.logout()).statusCode).toBe(401);
    if (!finish) throw new Error('Expected a pending fixture revocation.');
    finish(new Response(null, { status: 200 }));
    expect((await first).statusCode).toBe(200);
    expect(h.fetchMock).toHaveBeenCalledOnce(); expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it('preserves active roulette state and existing OBS viewing credentials', async () => {
    const h = setup();
    const source = streamerSchema.parse({
      id: user.id, login: user.login, displayName: user.display_name, avatarUrl: null, language: 'en',
      minViewers: 0, maxViewers: 1_000_000, acceptsOtherLanguages: true, reputation: 0,
    });
    const destination = candidateSchema.parse({
      streamerId: '987654321', login: 'fixture_target', displayName: 'Fixture Target', avatarUrl: null,
      language: 'en', illustrativeCountry: null, viewers: 50, gameName: '', title: '',
    });
    await h.runtime.coordinator.browserSpin(source, [destination], 'manual', 'fixture-active-spin');
    const before = await h.runtime.coordinator.snapshot(user.id);
    const viewing = [...h.runtime.issuedCredentials];
    await h.logout();
    expect(await h.runtime.coordinator.snapshot(user.id)).toEqual(before);
    expect([...h.runtime.issuedCredentials]).toEqual(viewing);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  destroySession('test-session');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('authenticated web entry points', () => {
  it('serves the overlay SPA for a valid channel route', async () => {
    const overlayRoot = await overlayFixture();
    const runtime = createRuntime({ reportError: () => undefined, overlayRoot });
    try {
      const response = await runtime.app.inject({ method: 'GET', url: '/themask957/overlay' });
      if (response.statusCode !== 200) {
        console.error('Overlay route failed:', response.statusCode, response.body);
      }
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('RaidSphere Overlay');
    } finally {
      await runtime.app.close();
    }
  });

  it('serves bundled globe textures without exposing arbitrary overlay files', async () => {
    const overlayRoot = await overlayFixture();
    const runtime = createRuntime({ reportError: () => undefined, overlayRoot });
    try {
      const texture = await runtime.app.inject({ method: 'GET', url: '/textures/earth-night.jpg' });
      expect(texture.statusCode).toBe(200);
      expect(texture.body).toBe('fixture');
      const source = await runtime.app.inject({ method: 'GET', url: '/src/main.ts' });
      expect(source.statusCode).toBe(404);
    } finally {
      await runtime.app.close();
    }
  });

  it('shows an authenticated dashboard with the private overlay URL', async () => {
    const overlayRoot = await overlayFixture();
    const runtime = createRuntime({ reportError: () => undefined, overlayRoot });
    createSession('test-session', user, tokens, {
      channelId: user.id,
      viewingCredential: 'x'.repeat(43),
    });

    try {
      const response = await runtime.app.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { cookie: 'raidsphere_session=test-session' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('TheMask957');
      expect(response.body).toContain('/themask957/overlay#channel=123456789&amp;cred=');
      expect(response.body).toContain('!roulette');
    } finally {
      await runtime.app.close();
    }
  });

  it('returns profile image URLs for discovered live streamers', async () => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'test-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/helix/streams') {
        return new Response(JSON.stringify({
          data: [{
            id: 'stream-1',
            user_id: 'streamer-1',
            user_login: 'streamerone',
            user_name: 'StreamerOne',
            game_id: 'game-1',
            game_name: 'Just Chatting',
            type: 'live',
            title: 'A live stream',
            viewer_count: 42,
            started_at: '2026-01-01T00:00:00Z',
            language: 'en',
            thumbnail_url: 'https://static-cdn.jtvnw.net/preview-{width}x{height}.jpg',
            tags: [],
            is_mature: false,
          }],
          pagination: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/helix/users') {
        return new Response(JSON.stringify({
          data: [{
            id: 'streamer-1',
            login: 'streamerone',
            display_name: 'StreamerOne',
            profile_image_url: 'https://static-cdn.jtvnw.net/avatar.png',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('Not found', { status: 404 });
    }));

    const overlayRoot = await overlayFixture();
    const runtime = createRuntime({ reportError: () => undefined, overlayRoot });
    createSession('test-session', user, tokens, {
      channelId: user.id,
      viewingCredential: 'x'.repeat(43),
    });

    try {
      const response = await runtime.app.inject({
        method: 'GET',
        url: '/api/test-helix',
        headers: { cookie: 'raidsphere_session=test-session' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().streams[0]).toMatchObject({
        id: 'streamer-1',
        profileImageUrl: 'https://static-cdn.jtvnw.net/avatar.png',
      });
    } finally {
      await runtime.app.close();
    }
  });

  it('allows public stream discovery with a server app token', async () => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'test-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/oauth2/token') {
        return new Response(JSON.stringify({
          access_token: 'test-app-token',
          expires_in: 3600,
          token_type: 'bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/helix/streams') {
        return new Response(JSON.stringify({
          data: [{
            id: 'stream-1', user_id: 'streamer-1', user_login: 'streamerone',
            user_name: 'StreamerOne', game_id: 'game-1', game_name: 'Just Chatting',
            type: 'live', title: 'A live stream', viewer_count: 42,
            started_at: '2026-01-01T00:00:00Z', language: 'en',
            thumbnail_url: 'https://static-cdn.jtvnw.net/preview-{width}x{height}.jpg',
            tags: [], is_mature: false,
          }],
          pagination: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/helix/users') {
        return new Response(JSON.stringify({ data: [{
          id: 'streamer-1', login: 'streamerone', display_name: 'StreamerOne',
          profile_image_url: 'https://static-cdn.jtvnw.net/avatar.png',
        }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    }));

    const overlayRoot = await overlayFixture();
    const runtime = createRuntime({ reportError: () => undefined, overlayRoot });
    try {
      const response = await runtime.app.inject({ method: 'GET', url: '/api/test-helix' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        authenticated_as: null,
        streams: [{ id: 'streamer-1', displayName: 'StreamerOne' }],
      });
    } finally {
      await runtime.app.close();
    }
  });
});
