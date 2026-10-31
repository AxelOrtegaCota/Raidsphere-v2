/**
 * Module B: Twitch OAuth implementation
 *
 * Handles OAuth 2.0 authorization flow for Twitch API access.
 * Uses native fetch only - no external dependencies.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Twitch OAuth tokens returned from token exchange or refresh.
 */
export interface TwitchTokens {
  /** Access token for API requests */
  access_token: string;
  /** Refresh token for obtaining new access tokens */
  refresh_token: string;
  /** Token type (typically "bearer") */
  token_type: string;
  /** Seconds until the access token expires */
  expires_in: number;
  /** Scopes granted to the token */
  scope: string[];
}

/**
 * Twitch user information from the /users endpoint.
 */
export interface TwitchUser {
  /** User's unique Twitch ID */
  id: string;
  /** User's login name (lowercase) */
  login: string;
  /** User's display name */
  display_name: string;
  /** User's email (requires user:read:email scope) */
  email?: string;
  /** URL to user's profile image */
  profile_image_url: string;
  /** User's broadcaster type */
  broadcaster_type: 'partner' | 'affiliate' | '';
  /** User's account description */
  description: string;
  /** Date when the account was created */
  created_at: string;
}

/**
 * Token validation response from Twitch.
 */
export interface TwitchTokenValidation {
  /** Client ID the token was issued to */
  client_id: string;
  /** User's login name */
  login: string;
  /** User's Twitch ID */
  user_id: string;
  /** Scopes the token has access to */
  scopes: string[];
  /** Seconds until the token expires */
  expires_in: number;
}

/**
 * OAuth configuration loaded from environment variables.
 */
export interface OAuthConfig {
  /** Twitch application client ID */
  clientId: string;
  /** Twitch application client secret */
  clientSecret: string;
  /** OAuth callback redirect URI */
  redirectUri: string;
  /** OAuth scopes to request */
  scopes: readonly string[];
}

/**
 * Session data for an authenticated user.
 */
export interface TwitchSession {
  /** User's Twitch ID */
  userId: string;
  /** User's login name (lowercase) */
  login: string;
  /** User's display name */
  displayName: string;
  /** URL to user's profile image */
  profileImageUrl: string;
  /** User's broadcaster type */
  broadcasterType: 'partner' | 'affiliate' | '';
  /** Access token for API requests */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken: string;
  /** Scopes granted to the session */
  scopes: string[];
  /** Timestamp when the access token expires */
  expiresAt: number;
}

/**
 * OAuth error with detailed information.
 */
export class OAuthError extends Error {
  /** Error code (e.g., 'invalid_grant', 'invalid_token') */
  public readonly code: string;
  /** Additional error details */
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.details = details;
  }
}

/**
 * OAuth error response from Twitch.
 */
export interface TwitchOAuthError {
  /** Error code */
  error: string;
  /** HTTP status code */
  status: number;
  /** Human-readable error message */
  message: string;
}

// ============================================================================
// Configuration
// ============================================================================

const TWITCH_AUTH_BASE_URL = 'https://id.twitch.tv/oauth2';
const TWITCH_API_BASE_URL = 'https://api.twitch.tv/helix';
const APP_TOKEN_EXPIRY_SKEW_MS = 60_000;

let cachedAppToken: { clientId: string; accessToken: string; expiresAtMs: number } | null = null;

/**
 * Required OAuth scopes for RaidSphere functionality:
 * - channel:manage:raids: Execute raids on behalf of the user
 * - user:read:chat: Receive chat messages through EventSub
 * - user:read:email: Access user email for account identification
 */
const REQUIRED_SCOPES = [
  'channel:manage:raids',
  'user:read:chat',
  'user:read:email',
] as const;

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Loads OAuth configuration from environment variables.
 *
 * @param env - Environment object (typically process.env)
 * @returns Validated OAuth configuration
 * @throws Error if required environment variables are missing
 *
 * @example
 * ```typescript
 * const config = loadOAuthConfig(process.env);
 * ```
 */
export function loadOAuthConfig(env: {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  TWITCH_REDIRECT_URI?: string;
}): OAuthConfig {
  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;
  const redirectUri = env.TWITCH_REDIRECT_URI;

  const missing: string[] = [];
  if (!clientId) missing.push('TWITCH_CLIENT_ID');
  if (!clientSecret) missing.push('TWITCH_CLIENT_SECRET');
  if (!redirectUri) missing.push('TWITCH_REDIRECT_URI');

  if (missing.length > 0) {
    const error = new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
    error.name = 'ZodError'; // Match expected error name for route handler
    throw error;
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    scopes: REQUIRED_SCOPES,
  };
}

/**
 * Returns a cached Twitch app access token for read-only public Helix discovery.
 * User-scoped actions such as raids must continue to use a user OAuth token.
 */
export async function getAppAccessToken(config: OAuthConfig): Promise<string> {
  const now = Date.now();
  if (
    cachedAppToken?.clientId === config.clientId
    && cachedAppToken.expiresAtMs - APP_TOKEN_EXPIRY_SKEW_MS > now
  ) {
    return cachedAppToken.accessToken;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'client_credentials',
  });
  // The secret travels in the body: URLs end up in logs and proxies.
  const response = await fetch(`${TWITCH_AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new OAuthError('app_token_failed', `Twitch app token request failed with status ${response.status}`);
  }

  const payload = await response.json() as Partial<{
    access_token: string;
    expires_in: number;
    token_type: string;
  }>;
  if (!payload.access_token || typeof payload.expires_in !== 'number') {
    throw new OAuthError('app_token_invalid', 'Twitch returned an invalid app token response');
  }

  cachedAppToken = {
    clientId: config.clientId,
    accessToken: payload.access_token,
    expiresAtMs: now + payload.expires_in * 1_000,
  };
  return payload.access_token;
}

// ============================================================================
// OAuth Functions
// ============================================================================

/**
 * Builds the Twitch OAuth authorization URL.
 *
 * The user should be redirected to this URL to begin the OAuth flow.
 * After authorization, Twitch redirects back with an authorization code.
 *
 * @param config - OAuth configuration
 * @param state - CSRF state parameter for security
 * @returns The full authorization URL to redirect the user to
 *
 * @example
 * ```typescript
 * const config = loadOAuthConfig(process.env);
 * const state = crypto.randomUUID();
 * const authUrl = buildAuthorizationUrl(config, state);
 * // Store state in session, then redirect user to authUrl
 * ```
 */
export function buildAuthorizationUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state: state,
  });

  return `${TWITCH_AUTH_BASE_URL}/authorize?${params.toString()}`;
}

/**
 * Generates the Twitch OAuth authorization URL.
 *
 * Alternative signature using environment variables directly.
 *
 * @param state - Optional state parameter for CSRF protection (recommended)
 * @returns The full authorization URL to redirect the user to
 */
export function generateAuthUrl(state?: string): string {
  const config = loadOAuthConfig(process.env);
  return buildAuthorizationUrl(config, state ?? '');
}

/**
 * Exchanges an authorization code for access and refresh tokens.
 *
 * This should be called after the user is redirected back from Twitch
 * with an authorization code in the query parameters.
 *
 * @param config - OAuth configuration
 * @param code - The authorization code from Twitch's redirect
 * @returns The token response containing access_token and refresh_token
 * @throws OAuthError if the exchange fails or credentials are invalid
 *
 * @example
 * ```typescript
 * const config = loadOAuthConfig(process.env);
 * const tokens = await exchangeCodeForTokens(config, code);
 * ```
 */
export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string
): Promise<TwitchTokens> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(`${TWITCH_AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = (await response.json()) as TwitchOAuthError;
    throw new OAuthError(
      error.error || 'token_exchange_failed',
      error.message || 'Failed to exchange authorization code for tokens',
      { status: response.status, error }
    );
  }

  const tokens = (await response.json()) as TwitchTokens;
  return tokens;
}

/**
 * Exchanges an authorization code for tokens (alternative signature).
 * Uses environment variables for configuration.
 *
 * @param code - The authorization code from Twitch's redirect
 * @returns The token response containing access_token and refresh_token
 */
export async function exchangeCode(code: string): Promise<TwitchTokens> {
  const config = loadOAuthConfig(process.env);
  return exchangeCodeForTokens(config, code);
}

/**
 * Fetches the authenticated user's profile information.
 *
 * @param config - OAuth configuration
 * @param accessToken - A valid access token
 * @returns The user's Twitch profile information
 * @throws OAuthError if the request fails or token is invalid
 *
 * @example
 * ```typescript
 * const config = loadOAuthConfig(process.env);
 * const user = await fetchUserInfo(config, tokens.access_token);
 * ```
 */
export async function fetchUserInfo(
  config: OAuthConfig,
  accessToken: string
): Promise<TwitchUser> {
  const response = await fetch(`${TWITCH_API_BASE_URL}/users`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': config.clientId,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new OAuthError(
        'invalid_token',
        'Access token is invalid or has expired'
      );
    }
    const text = await response.text();
    throw new OAuthError(
      'user_fetch_failed',
      `Failed to fetch user info: ${response.status}`,
      { status: response.status, body: text }
    );
  }

  const data = (await response.json()) as { data: TwitchUser[] };

  if (!data.data || data.data.length === 0) {
    throw new OAuthError(
      'no_user_data',
      'No user data returned from Twitch API'
    );
  }

  const user = data.data[0];
  if (!user) {
    throw new OAuthError('no_user_data', 'User data is undefined');
  }
  return user;
}

/**
 * Fetches authenticated user (alternative signature).
 * Uses environment variables for configuration.
 *
 * @param accessToken - A valid access token
 * @returns The user's Twitch profile information
 */
export async function getAuthenticatedUser(
  accessToken: string
): Promise<TwitchUser> {
  const config = loadOAuthConfig(process.env);
  return fetchUserInfo(config, accessToken);
}

/**
 * Creates a session data object from tokens and user info.
 *
 * @param tokens - The OAuth tokens from token exchange
 * @param user - The user info from Twitch API
 * @returns A session data object ready for storage
 *
 * @example
 * ```typescript
 * const session = createSessionData(tokens, user);
 * sessions.set(sessionId, session);
 * ```
 */
export function createSessionData(
  tokens: TwitchTokens,
  user: TwitchUser
): TwitchSession {
  return {
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url,
    broadcasterType: user.broadcaster_type,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope,
    // Calculate expiration timestamp (use 10-minute buffer for safety)
    expiresAt: Date.now() + (tokens.expires_in - 600) * 1000,
  };
}

/**
 * Alias for createSessionData for backward compatibility.
 * @deprecated Use createSessionData instead.
 */
export const createSession = createSessionData;

/**
 * Refreshes an expired access token using a refresh token.
 *
 * @param config - OAuth configuration
 * @param refreshTokenValue - The refresh token from a previous token exchange
 * @returns New tokens (including a potentially new refresh token)
 * @throws OAuthError if the refresh fails or the refresh token is invalid
 *
 * @example
 * ```typescript
 * const config = loadOAuthConfig(process.env);
 * const newTokens = await refreshAccessToken(config, session.refreshToken);
 * ```
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshTokenValue: string
): Promise<TwitchTokens> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });

  const response = await fetch(`${TWITCH_AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = (await response.json()) as TwitchOAuthError;
    throw new OAuthError(
      error.error || 'refresh_failed',
      error.message || 'Failed to refresh access token',
      { status: response.status, error }
    );
  }

  const tokens = (await response.json()) as TwitchTokens;
  return tokens;
}

/**
 * Refreshes an expired access token (alternative signature).
 * Uses environment variables for configuration.
 *
 * @param refreshTokenValue - The refresh token from a previous token exchange
 * @returns New tokens (including a potentially new refresh token)
 */
export async function refreshToken(
  refreshTokenValue: string
): Promise<TwitchTokens> {
  const config = loadOAuthConfig(process.env);
  return refreshAccessToken(config, refreshTokenValue);
}

/**
 * Validates an access token and retrieves its metadata.
 *
 * @param accessToken - The access token to validate
 * @returns Validation info including user_id, login, scopes, and expiration
 * @throws OAuthError if the token is invalid or validation fails
 *
 * @example
 * ```typescript
 * const validation = await validateToken(accessToken);
 * console.log(`Token valid for ${validation.expires_in} seconds`);
 * ```
 */
export async function validateToken(
  accessToken: string
): Promise<TwitchTokenValidation> {
  const response = await fetch(`${TWITCH_AUTH_BASE_URL}/validate`, {
    method: 'GET',
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new OAuthError(
        'invalid_token',
        'Token is invalid or has expired'
      );
    }
    const error = (await response.json()) as TwitchOAuthError;
    throw new OAuthError(
      error.error || 'validation_failed',
      error.message || 'Failed to validate token',
      { status: response.status, error }
    );
  }

  const validation = (await response.json()) as TwitchTokenValidation;
  return validation;
}

/**
 * Revokes an access token, invalidating it immediately.
 *
 * @param configOrToken - OAuth configuration or the access token directly
 * @param accessToken - The access token to revoke (if config provided as first arg)
 * @throws OAuthError if the revocation request fails
 *
 * @example
 * ```typescript
 * // With config:
 * const config = loadOAuthConfig(process.env);
 * await revokeToken(config, session.accessToken);
 *
 * // Or just token:
 * await revokeToken(session.accessToken);
 * ```
 */
export async function revokeToken(
  configOrToken: OAuthConfig | string,
  accessToken?: string
): Promise<void> {
  let config: OAuthConfig;
  let token: string;

  if (typeof configOrToken === 'string') {
    // Single argument: just the token
    config = loadOAuthConfig(process.env);
    token = configOrToken;
  } else {
    // Two arguments: config and token
    config = configOrToken;
    token = accessToken!;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    token: token,
  });

  const response = await fetch(`${TWITCH_AUTH_BASE_URL}/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthError(
      'revocation_failed',
      `Failed to revoke token: ${response.status}`,
      { status: response.status, body: text }
    );
  }
}

/**
 * Checks if a token has the required scopes for RaidSphere.
 *
 * @param scopes - Array of scopes from token validation
 * @returns true if all required scopes are present
 */
export function hasRequiredScopes(scopes: string[]): boolean {
  return REQUIRED_SCOPES.every((required) => scopes.includes(required));
}

/**
 * Gets the list of required OAuth scopes.
 * @returns Array of required scope strings
 */
export function getRequiredScopes(): readonly string[] {
  return REQUIRED_SCOPES;
}
