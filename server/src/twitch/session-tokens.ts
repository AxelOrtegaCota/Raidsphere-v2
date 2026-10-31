/**
 * Module B: supplies a user's access token from their session.
 * Refresh tokens rotate, so concurrent callers share one refresh.
 */
import { refreshAccessToken, type OAuthConfig, type TwitchTokens } from './oauth.js';
import { getSessionByUserId, updateSessionTokens } from './sessions.js';

export type AccessTokenProvider = (options: { forceRefresh: boolean }) => Promise<string>;

export interface SessionTokenProviderDependencies {
  userId: string;
  config: OAuthConfig;
  refresh?: (config: OAuthConfig, refreshToken: string) => Promise<TwitchTokens>;
}

export function createSessionTokenProvider(dependencies: SessionTokenProviderDependencies): AccessTokenProvider {
  const { userId, config, refresh = refreshAccessToken } = dependencies;
  let refreshing: Promise<string> | null = null;

  const renew = async (): Promise<string> => {
    const session = getSessionByUserId(userId);
    if (!session) throw new Error('No Twitch session for this user.');
    const tokens = await refresh(config, session.tokens.refresh_token);
    updateSessionTokens(session.sessionId, tokens);
    return tokens.access_token;
  };

  return async ({ forceRefresh }) => {
    if (forceRefresh) {
      refreshing ??= renew().finally(() => { refreshing = null; });
      return refreshing;
    }
    const session = getSessionByUserId(userId);
    if (!session) throw new Error('No Twitch session for this user.');
    return session.tokens.access_token;
  };
}
