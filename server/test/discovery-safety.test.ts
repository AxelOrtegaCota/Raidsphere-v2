import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/composition.js';
import { createRateLimiter } from '../src/routes/rate-limit.js';
import { getAppAccessToken } from '../src/twitch/oauth.js';

// All values are test fixtures; no Twitch request is made.
const CONFIG = { clientId: 'safety-client', clientSecret: 'safety-secret', redirectUri: 'http://localhost/auth/callback' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('app access token', () => {
  it('sends the client secret in the request body, never in the URL', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ access_token: 'test-app-token', expires_in: 3600, token_type: 'bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await getAppAccessToken(CONFIG as Parameters<typeof getAppAccessToken>[0]);

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).not.toContain('safety-secret');
    expect(String(input)).not.toContain('?');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('client_secret=safety-secret');
  });
});

describe('rate limiter', () => {
  const limit = { windowMs: 1_000, max: 2, maxKeys: 2 };

  it('allows up to the maximum and reports when to retry', () => {
    let nowMs = 0;
    const check = createRateLimiter(limit, () => nowMs);
    expect(check('a')).toEqual({ allowed: true });
    expect(check('a')).toEqual({ allowed: true });
    nowMs = 400;
    expect(check('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('starts a new window once the interval passes and keeps callers apart', () => {
    let nowMs = 0;
    const check = createRateLimiter(limit, () => nowMs);
    check('a');
    check('a');
    expect(check('b')).toEqual({ allowed: true });
    nowMs = 1_000;
    expect(check('a')).toEqual({ allowed: true });
  });

  it('forgets the oldest caller beyond the key limit', () => {
    const check = createRateLimiter(limit, () => 0);
    check('a');
    check('a');
    check('b');
    check('c');
    expect(check('a')).toEqual({ allowed: true });
  });
});

describe('public discovery routes', () => {
  it('answers 429 past the limit, and hides upstream error details', async () => {
    vi.stubEnv('TWITCH_CLIENT_ID', 'safety-client');
    vi.stubEnv('TWITCH_CLIENT_SECRET', 'safety-secret');
    vi.stubEnv('TWITCH_REDIRECT_URI', 'http://localhost/auth/callback');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === '/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'test-app-token', expires_in: 3600, token_type: 'bearer' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('internal upstream detail');
    }));
    const runtime = createRuntime({ reportError: () => undefined });
    try {
      const failed = await runtime.app.inject({ method: 'GET', url: '/api/categories?q=test' });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('internal upstream detail');

      let last = failed;
      for (let index = 0; index < 120; index += 1) {
        last = await runtime.app.inject({ method: 'GET', url: '/api/categories' });
      }
      expect(last.statusCode).toBe(429);
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await runtime.app.close();
    }
  });
});
