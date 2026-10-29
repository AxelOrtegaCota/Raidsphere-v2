/**
 * Module B: Twitch integration index
 * 
 * Exports all Twitch-related functionality for Phase 2.
 * In Phase 3, real Twitch adapters replace the simulated ones.
 */

// Command parsing
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

// Synthetic candidates
export {
  getSyntheticCandidates,
  getAvailableLanguages,
  filterCandidatesByLanguage,
  selectRandomCandidate,
  type CandidateFilters,
} from './candidates.js';

// Raid gateway
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
  RaidGatewayAdapter,
  type RaidGatewayAdapterDependencies,
} from './adapters.js';
