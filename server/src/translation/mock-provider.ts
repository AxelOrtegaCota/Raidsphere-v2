/**
 * Module C: Mock translation provider
 * 
 * Fake translation for Phase 2 development.
 * Returns predictable translations for testing without API costs.
 * In Phase 4, this is replaced by GPT-4o-mini or another real provider.
 */

import type { LanguageCode } from '@raidsphere/shared';
import { fragmentMessage, restoreFragments } from './emotes.js';
import type {
  TranslationProvider,
  TranslationRequest,
  TranslationResponse,
  TranslationResult,
} from './provider.js';

// Fake translation dictionary for common phrases
const MOCK_TRANSLATIONS: Record<string, Record<LanguageCode, string>> = {
  'hello': { en: 'hello', es: 'hola', pt: 'olá', fr: 'bonjour', de: 'hallo', ja: 'こんにちは', ko: '안녕하세요' },
  'how are you': { en: 'how are you', es: '¿cómo estás?', pt: 'como você está?', fr: 'comment allez-vous?', de: 'wie geht es dir?', ja: 'お元気ですか', ko: '어떻게 지내세요' },
  'good game': { en: 'good game', es: 'buen juego', pt: 'bom jogo', fr: 'bien joué', de: 'gutes Spiel', ja: 'グッドゲーム', ko: '좋은 게임' },
  'nice stream': { en: 'nice stream', es: 'buen stream', pt: 'boa live', fr: 'bon stream', de: 'guter Stream', ja: 'いい配信', ko: '좋은 방송' },
  'thanks for the raid': { en: 'thanks for the raid', es: 'gracias por el raid', pt: 'obrigado pelo raid', fr: 'merci pour le raid', de: 'danke für den Raid', ja: 'レイドありがとう', ko: '레이드 감사합니다' },
  'welcome raiders': { en: 'welcome raiders', es: 'bienvenidos raiders', pt: 'bem-vindos raiders', fr: 'bienvenue les raiders', de: 'willkommen Raiders', ja: 'レイダーようこそ', ko: '레이더 환영합니다' },
  'lets go': { en: "let's go", es: 'vamos', pt: 'vamos', fr: 'allons-y', de: 'los geht\'s', ja: '行こう', ko: '가자' },
};

// Language-specific prefixes for mock translations
const LANGUAGE_PREFIXES: Record<LanguageCode, string> = {
  en: '[EN]',
  es: '[ES]',
  pt: '[PT]',
  fr: '[FR]',
  de: '[DE]',
  ja: '[JA]',
  ko: '[KO]',
};

export class MockTranslationProvider implements TranslationProvider {
  name = 'mock';
  
  private minLatencyMs: number;
  private maxLatencyMs: number;
  private failureRate: number;
  
  constructor(options: { minLatencyMs?: number; maxLatencyMs?: number; failureRate?: number } = {}) {
    this.minLatencyMs = options.minLatencyMs ?? 100;
    this.maxLatencyMs = options.maxLatencyMs ?? 500;
    this.failureRate = options.failureRate ?? 0; // 0 = never fail
  }
  
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const startTime = Date.now();
    
    // Simulate network latency
    const latency = this.minLatencyMs + Math.random() * (this.maxLatencyMs - this.minLatencyMs);
    await sleep(latency);
    
    // Simulate occasional failures
    if (Math.random() < this.failureRate) {
      return {
        success: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: 'Mock provider simulated failure',
          retryAfterMs: 1000,
        },
      };
    }
    
    // Skip if same language
    if (request.sourceLanguage === request.targetLanguage) {
      return {
        success: true,
        result: {
          originalText: request.text,
          translatedText: request.text,
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          confidence: 1.0,
          latencyMs: Date.now() - startTime,
          provider: this.name,
          cached: false,
        },
      };
    }
    
    // Fragment message to preserve emotes
    const fragmented = fragmentMessage(request.text, request.channelEmotes);
    
    // Translate the protected text
    const translatedProtected = this.mockTranslate(
      fragmented.protectedText,
      request.sourceLanguage,
      request.targetLanguage
    );
    
    // Restore emotes
    const translatedText = restoreFragments(translatedProtected, fragmented);
    
    const result: TranslationResult = {
      originalText: request.text,
      translatedText,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      confidence: 0.85, // Mock confidence
      latencyMs: Date.now() - startTime,
      provider: this.name,
      cached: false,
    };
    
    return { success: true, result };
  }
  
  supportsLanguagePair(_source: LanguageCode, _target: LanguageCode): boolean {
    // Mock supports all pairs
    return true;
  }
  
  getEstimatedCost(_textLength: number): number {
    // Mock is free
    return 0;
  }
  
  async isHealthy(): Promise<boolean> {
    return true;
  }
  
  /**
   * Generate mock translation.
   * - Checks dictionary first
   * - Falls back to prefix + original text
   */
  private mockTranslate(text: string, _source: LanguageCode, target: LanguageCode): string {
    const lowerText = text.toLowerCase().trim();
    
    // Check if we have a canned translation
    if (MOCK_TRANSLATIONS[lowerText]?.[target]) {
      return MOCK_TRANSLATIONS[lowerText][target];
    }
    
    // For unknown text, return with language prefix (simulating translation)
    const prefix = LANGUAGE_PREFIXES[target];
    return `${prefix} ${text}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Default instance
let defaultProvider: TranslationProvider | null = null;

export function getTranslationProvider(): TranslationProvider {
  if (!defaultProvider) {
    defaultProvider = new MockTranslationProvider();
  }
  return defaultProvider;
}

export function setTranslationProvider(provider: TranslationProvider): void {
  defaultProvider = provider;
}
