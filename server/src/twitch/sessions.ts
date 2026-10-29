/**
 * Session Manager — In-memory storage for authenticated users
 * 
 * Stores Twitch tokens and user info per session.
 * In production, this would be backed by Redis or a database.
 */

import type { TwitchTokens, TwitchUser } from './oauth.js';

// ============================================================================
// Types
// ============================================================================

export interface UserSession {
  sessionId: string;
  userId: string;
  user: TwitchUser;
  tokens: TwitchTokens;
  createdAt: number;
  lastAccessedAt: number;
}

// ============================================================================
// Session Store
// ============================================================================

const sessions = new Map<string, UserSession>();
const userToSession = new Map<string, string>(); // userId -> sessionId

// Session TTL: 7 days
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new session for an authenticated user.
 * If the user already has a session, it's replaced.
 */
export function createSession(
  sessionId: string,
  user: TwitchUser,
  tokens: TwitchTokens
): UserSession {
  // Remove old session if exists
  const oldSessionId = userToSession.get(user.id);
  if (oldSessionId) {
    sessions.delete(oldSessionId);
  }
  
  const session: UserSession = {
    sessionId,
    userId: user.id,
    user,
    tokens,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  
  sessions.set(sessionId, session);
  userToSession.set(user.id, sessionId);
  
  console.info(`[Session] Created session for ${user.display_name} (${user.id})`);
  return session;
}

/**
 * Get a session by ID.
 * Updates lastAccessedAt and returns null if expired.
 */
export function getSession(sessionId: string): UserSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  
  // Check expiry
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    destroySession(sessionId);
    return null;
  }
  
  // Update last accessed
  session.lastAccessedAt = Date.now();
  return session;
}

/**
 * Get a session by user ID.
 */
export function getSessionByUserId(userId: string): UserSession | null {
  const sessionId = userToSession.get(userId);
  if (!sessionId) return null;
  return getSession(sessionId);
}

/**
 * Update tokens for a session (after refresh).
 */
export function updateSessionTokens(sessionId: string, tokens: TwitchTokens): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  session.tokens = tokens;
  session.lastAccessedAt = Date.now();
  return true;
}

/**
 * Destroy a session (logout).
 */
export function destroySession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  sessions.delete(sessionId);
  userToSession.delete(session.userId);
  console.info(`[Session] Destroyed session for user ${session.userId}`);
  return true;
}

/**
 * Get all active sessions (for admin/debug).
 */
export function getAllSessions(): UserSession[] {
  return Array.from(sessions.values());
}

/**
 * Clean up expired sessions.
 * Should be called periodically.
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let count = 0;
  
  for (const [sessionId, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      destroySession(sessionId);
      count++;
    }
  }
  
  if (count > 0) {
    console.info(`[Session] Cleaned up ${count} expired sessions`);
  }
  
  return count;
}

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
