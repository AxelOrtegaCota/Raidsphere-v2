import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConfig, TwitchTokens, TwitchUser } from '../src/twitch/oauth.js';
import { createSession, destroySession, getSession } from '../src/twitch/sessions.js';
import { createSessionTokenProvider } from '../src/twitch/session-tokens.js';

// All values are test fixtures; no Twitch request is made.
const CONFIG = { clientId: 'fixture-client', clientSecret: 'fixture-secret' } as OAuthConfig;
const USER = { id: 'token-user', display_name: 'Fixture' } as TwitchUser;
const tokens = (access: string, refresh: string): TwitchTokens => ({
  access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, scope: [],
});

describe('session token provider', () => {
  afterEach(() => { destroySession('token-session'); });

  const open = (): void => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    createSession('token-session', USER, tokens('access-1', 'refresh-1'), { channelId: USER.id, viewingCredential: 'fixture' });
  };

  it('returns the session token without refreshing', async () => {
    open();
    const refresh = vi.fn();
    const provider = createSessionTokenProvider({ userId: USER.id, config: CONFIG, refresh });
    await expect(provider({ forceRefresh: false })).resolves.toBe('access-1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stores refreshed tokens and shares one refresh between callers', async () => {
    open();
    const refresh = vi.fn(async () => tokens('access-2', 'refresh-2'));
    const provider = createSessionTokenProvider({ userId: USER.id, config: CONFIG, refresh });

    const results = await Promise.all([provider({ forceRefresh: true }), provider({ forceRefresh: true })]);

    expect(results).toEqual(['access-2', 'access-2']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(CONFIG, 'refresh-1');
    expect(getSession('token-session')?.tokens.refresh_token).toBe('refresh-2');
  });

  it('can refresh again after a failed attempt', async () => {
    open();
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('fixture failure'))
      .mockResolvedValueOnce(tokens('access-2', 'refresh-2'));
    const provider = createSessionTokenProvider({ userId: USER.id, config: CONFIG, refresh });

    await expect(provider({ forceRefresh: true })).rejects.toThrow('fixture failure');
    await expect(provider({ forceRefresh: true })).resolves.toBe('access-2');
  });

  it('fails when the user has no session', async () => {
    const provider = createSessionTokenProvider({ userId: 'missing', config: CONFIG, refresh: vi.fn() });
    await expect(provider({ forceRefresh: false })).rejects.toThrow('No Twitch session for this user.');
  });
});
