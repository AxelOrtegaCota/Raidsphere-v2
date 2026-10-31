/**
 * Module C: Translation index
 *
 * Exports all translation functionality for Phase 2.
 */

// Emote preservation
export {
  fragmentMessage,
  restoreFragments,
  extractEmotes,
  type Fragment,
  type FragmentedMessage,
} from './emotes.js';

// Provider interface
export {
  getLanguageName,
  needsTranslation,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
  type TranslationError,
  type TranslationResponse,
  type TranslationProviderExecutionContext,
  MAX_TRANSLATION_EMOTES,
  MAX_TRANSLATION_EMOTE_CHARACTERS,
  type LanguagePair,
} from './provider.js';

// Mock provider
export {
  MockTranslationProvider,
  getTranslationProvider,
  setTranslationProvider,
} from './mock-provider.js';

// Adapter to the Module D chat translator port
export {
  ServiceChatTranslator,
  type ServiceChatTranslatorOptions,
} from './chat-translator.js';

// Service
export {
  translateMessage,
  translateMessages,
  getTranslationMetrics,
  resetTranslationMetrics,
  clearTranslationCache,
  TRANSLATION_LIMITS,
  activateTranslationSession,
  isTranslationSessionActive,
  invalidateTranslationMessage,
  invalidateTranslationUser,
  invalidateTranslationChannel,
  invalidateTranslationSession,
  disposeTranslationService,
  resumeTranslationService,
  getTranslationSchedulerState,
  type TranslationSession,
  type TranslationExecutionOptions,
  type TranslateMessageOptions,
  type TranslationMetrics,
} from './service.js';
