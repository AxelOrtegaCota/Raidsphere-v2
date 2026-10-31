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
  type EventSubClient,
  type EventSubClientOptions,
  type EventSubEnvelope,
  type EventSubNotification,
  type EventSubStatus,
  type RaidEvent,
  type ChannelChatMessageEvent,
  type ChatMessageDeleteEvent,
  type ChatClearEvent,
  type ChatClearUserEvent,
} from './eventsub.js';
export {
  createSessionTokenProvider,
  type AccessTokenProvider,
  type SessionTokenProviderDependencies,
} from './session-tokens.js';
export {
  LiveChat,
  type LiveChatDependencies,
  type LiveChatOptions,
  type LiveChatState,
} from './live-chat.js';
export {
  RegisteredCandidateSource,
  type RegisteredCandidateDependencies,
  type RegisteredCandidateOptions,
} from './registered-candidates.js';

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

// Adapters to the Module D application ports
export {
  commandRole,
  toChatCommand,
  toChatTextMessage,
  RaidGatewayAdapter,
  type RaidGatewayAdapterDependencies,
} from './adapters.js';
export {
  isFromAnotherChannel,
  toChatFragments,
  toChatMessage,
  toModerationAction,
  toRaidArrival,
} from './eventsub-adapters.js';
