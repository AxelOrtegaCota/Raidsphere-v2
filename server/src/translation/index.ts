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
  type LanguagePair,
} from './provider.js';

// Mock provider
export {
  MockTranslationProvider,
  getTranslationProvider,
  setTranslationProvider,
} from './mock-provider.js';

// Service
export {
  translateMessage,
  translateMessages,
  getTranslationMetrics,
  resetTranslationMetrics,
  clearTranslationCache,
  type TranslateMessageOptions,
  type TranslationMetrics,
} from './service.js';
