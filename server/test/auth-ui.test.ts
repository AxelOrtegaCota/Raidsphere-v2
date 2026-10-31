import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/composition.js';
import { createSession, destroySession } from '../src/twitch/sessions.js';
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
