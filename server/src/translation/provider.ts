/**
 * Module C: Translation provider interface
 * 
 * Defines the contract for translation providers.
 * Phase 2 uses a mock provider; Phase 4 integrates real LLM/API.
 */

import type { LanguageCode } from '@raidsphere/shared';

export interface TranslationRequest {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  context?: string; // Optional context for better translation
  channelEmotes?: string[]; // Emotes to preserve
}

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  confidence: number; // 0-1
  latencyMs: number;
  provider: string;
  cached: boolean;
}

export interface TranslationError {
  code: 'RATE_LIMIT' | 'TIMEOUT' | 'INVALID_LANGUAGE' | 'PROVIDER_ERROR' | 'UNKNOWN';
  message: string;
  retryAfterMs?: number;
}

export type TranslationResponse = 
  | { success: true; result: TranslationResult }
  | { success: false; error: TranslationError };

/**
 * Abstract translation provider interface.
 * All providers must implement this contract.
 */
export interface TranslationProvider {
  name: string;
  
  /**
   * Translate text from source to target language.
   */
  translate(request: TranslationRequest): Promise<TranslationResponse>;
  
  /**
   * Check if the provider supports the given language pair.
   */
  supportsLanguagePair(source: LanguageCode, target: LanguageCode): boolean;
  
  /**
   * Get estimated cost per translation (for monitoring).
   */
  getEstimatedCost(textLength: number): number;
  
  /**
   * Health check for the provider.
   */
  isHealthy(): Promise<boolean>;
}

/**
 * Language pair supported for translation.
 */
export interface LanguagePair {
  source: LanguageCode;
  target: LanguageCode;
}

/**
 * Get display name for language.
 */
export function getLanguageName(code: LanguageCode): string {
  const names: Record<LanguageCode, string> = {
    en: 'English',
    es: 'Spanish',
    pt: 'Portuguese',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
  };
  return names[code];
}

/**
 * Check if translation is needed (same language = no translation).
 */
export function needsTranslation(source: LanguageCode, target: LanguageCode): boolean {
  return source !== target;
}
