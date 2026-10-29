/**
 * Module B: Twitch integration index
 * 
 * Exports all Twitch-related functionality.
 * Phase 2: simulated adapters. Phase 3: real Twitch integration.
 */

// ============================================================================
// Phase 3: OAuth
// ============================================================================
export {
  // Config and URL generation
  loadOAuthConfig,
  buildAuthorizationUrl,
  generateAuthUrl,
  // Token operations
  exchangeCodeForTokens,
  exchangeCode,
  refreshAccessToken,
  refreshToken,
  validateToken,
  revokeToken,
  // User info
  fetchUserInfo,
  getAuthenticatedUser,
  // Session data (renamed to avoid conflict with sessions.ts)
  createSessionData,
  // Scope helpers
  hasRequiredScopes,
  getRequiredScopes,
  // Error class
  OAuthError,
  // Types
  type OAuthConfig,
  type TwitchTokens,
  type TwitchUser,
  type TwitchSession,
  type TwitchTokenValidation,
  type TwitchOAuthError,
} from './oauth.js';

// ============================================================================
// Phase 3: Helix API
// ============================================================================
export {
  searchChannels,
  getChannelInfo,
  startRaid as helixStartRaid,
  cancelRaid as helixCancelRaid,
  getStreams,
  getUsers,
  HelixError,
  RateLimitError,
  type Channel,
  type Stream,
  type HelixUser,
  type RaidResponse as HelixRaidResponse,
  type HelixApiError,
  type HelixRequestConfig,
} from './helix.js';

// ============================================================================
// Phase 3: EventSub
// ============================================================================
export {
  createEventSubClient,
  parseRaidEvent,
  parseChatCommand,
  type EventSubClient,
  type EventSubClientOptions,
  type EventSubSubscription,
  type EventSubMessage,
  type RaidEvent,
  type ChannelChatMessageEvent,
  type DetectedRaid,
  type DetectedCommand,
} from './eventsub.js';

// ============================================================================
// Phase 3: Sessions
// ============================================================================
export {
  createSession,
  getSession,
  getSessionByUserId,
  updateSessionTokens,
  destroySession,
  getAllSessions,
  cleanupExpiredSessions,
  type UserSession,
} from './sessions.js';

// ============================================================================
// Phase 2: Command parsing
// ============================================================================
export {
  parseCommand,
  normalizeLanguage,
  getLanguageDisplayName,
  getLanguageFlag,
  hasControlPermission,
  hasVotePermission,
  chatMessageSchema,
  type ChatMessage,
  type ParsedCommand,
  type ParseResult,
  type ParseError,
  type RouletteCommand,
  type VoteCommand,
  type CancelCommand,
} from './commands.js';

// ============================================================================
// Phase 2: Synthetic candidates
// ============================================================================
export {
  getSyntheticCandidates,
  getAvailableLanguages,
  filterCandidatesByLanguage,
  selectRandomCandidate,
  type CandidateFilters,
} from './candidates.js';

// ============================================================================
// Phase 2: Raid gateway (simulated)
// ============================================================================
export {
  SimulatedRaidGateway,
  getRaidGateway,
  setRaidGateway,
  type RaidRequest,
  type RaidCorrelation,
  type RaidResponse,
  type RaidArrivalEvent,
  type RaidOutcome,
  type RaidTerminalOutcome,
  type RaidOutcomeEvent,
  type RaidRejectionReason,
  type RaidUnknownReason,
  type RaidCancellationRequest,
  type RaidCancellationResult,
  type SimulationConfig,
} from './raids.js';
