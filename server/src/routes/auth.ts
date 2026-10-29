/**
 * Authentication routes for RaidSphere
 * 
 * Implements Twitch OAuth2 flow with session management.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import {
  generateAuthUrl,
  exchangeCode,
  getAuthenticatedUser,
  revokeToken,
  loadOAuthConfig,
  type TwitchTokens,
  type TwitchUser,
} from '../twitch/oauth.js';
import {
  createSession,
  getSession,
  destroySession,
  type UserSession,
} from '../twitch/sessions.js';

// CSRF state tokens (short-lived, for OAuth flow only)
const pendingStates = new Map<string, { createdAt: number }>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Session cookie name
const SESSION_COOKIE_NAME = 'raidsphere_session';

/**
 * Get session from cookie or query parameter
 */
function getSessionId(request: FastifyRequest): string | undefined {
  // Try cookie first
  const cookies = request.headers.cookie;
  if (cookies) {
    const match = cookies.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) {
      return match[1];
    }
  }
  // Fallback to query parameter (for testing/debugging)
  const query = request.query as Record<string, unknown>;
  if (typeof query.sessionId === 'string') {
    return query.sessionId;
  }
  return undefined;
}

/**
 * Clean up expired CSRF states
 */
function cleanupPendingStates(): void {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

// Cleanup every minute
setInterval(cleanupPendingStates, 60 * 1000);

/**
 * Register auth routes on a Fastify instance
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  
  /**
   * GET /auth/twitch
   * Redirects to Twitch OAuth authorization page
   */
  app.get('/auth/twitch', async (request: FastifyRequest, reply: FastifyReply) => {
    const state = randomUUID();
    pendingStates.set(state, { createdAt: Date.now() });
    
    const authUrl = generateAuthUrl(state);
    console.info(`[Auth] Redirecting to Twitch OAuth (state: ${state.slice(0, 8)}...)`);
    
    return reply.redirect(authUrl);
  });
  
  /**
   * GET /auth/callback
   * Handles OAuth callback from Twitch
   */
  app.get('/auth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    
    // Check for errors
    if (query.error) {
      console.error(`[Auth] OAuth error: ${query.error} - ${query.error_description}`);
      return reply.status(400).send({
        error: 'OAuth failed',
        message: String(query.error_description || query.error),
      });
    }
    
    const code = query.code;
    const state = query.state;
    
    if (typeof code !== 'string' || typeof state !== 'string') {
      return reply.status(400).send({
        error: 'Invalid callback',
        message: 'Missing code or state parameter',
      });
    }
    
    // Validate state to prevent CSRF
    if (!pendingStates.has(state)) {
      return reply.status(400).send({
        error: 'Invalid state',
        message: 'CSRF validation failed or state expired',
      });
    }
    pendingStates.delete(state);
    
    try {
      // Exchange code for tokens
      console.info('[Auth] Exchanging code for tokens...');
      const tokens = await exchangeCode(code);
      
      // Get user info
      console.info('[Auth] Fetching user info...');
      const user = await getAuthenticatedUser(tokens.access_token);
      
      // Create session
      const sessionId = randomUUID();
      createSession(sessionId, user, tokens);
      
      console.info(`[Auth] Successfully authenticated: ${user.display_name} (${user.id})`);
      
      // Set session cookie and redirect to overlay
      const redirectUrl = `/${user.login}/overlay`;
      
      return reply
        .header('Set-Cookie', `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`)
        .redirect(redirectUrl);
        
    } catch (error) {
      console.error('[Auth] Authentication failed:', error);
      return reply.status(500).send({
        error: 'Authentication failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
  
  /**
   * GET /auth/me
   * Returns current user info
   */
  app.get('/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = getSessionId(request);
    if (!sessionId) {
      return reply.status(401).send({
        error: 'Not authenticated',
        message: 'No session found',
      });
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return reply.status(401).send({
        error: 'Session expired',
        message: 'Please log in again',
      });
    }
    
    return {
      user: {
        id: session.user.id,
        login: session.user.login,
        display_name: session.user.display_name,
        profile_image_url: session.user.profile_image_url,
      },
      authenticated_at: session.createdAt,
    };
  });
  
  /**
   * POST /auth/logout
   * Invalidates current session
   */
  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = getSessionId(request);
    if (!sessionId) {
      return reply.status(200).send({ message: 'Already logged out' });
    }
    
    const session = getSession(sessionId);
    if (session) {
      try {
        // Revoke token at Twitch
        const config = loadOAuthConfig(process.env);
        await revokeToken(config, session.tokens.access_token);
      } catch (error) {
        // Log but don't fail - token might already be invalid
        console.warn('[Auth] Failed to revoke token:', error);
      }
      
      destroySession(sessionId);
      console.info(`[Auth] User ${session.user.login} logged out`);
    }
    
    return reply
      .header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`)
      .send({ message: 'Logged out successfully' });
  });
  
  /**
   * GET /auth/status
   * Quick check if user is authenticated
   */
  app.get('/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = getSessionId(request);
    if (!sessionId) {
      return { authenticated: false };
    }
    
    const session = getSession(sessionId);
    if (!session) {
      return { authenticated: false };
    }
    
    return {
      authenticated: true,
      user: session.user.login,
    };
  });
}
