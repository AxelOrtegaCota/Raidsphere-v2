/**
 * Module C: Explicitly simulated translations for local development.
 * Dictionary entries and language prefixes are not verified AI translations.
 */
import { languageCodeSchema } from '@raidsphere/shared';
import type { LanguageCode } from '@raidsphere/shared';
import { fragmentMessage, restoreFragments } from './emotes.js';
import { translationRequestSchema, translationResultSchema } from './provider.js';
import type { TranslationProvider, TranslationRequest, TranslationResponse, TranslationResult } from './provider.js';

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
  readonly provenance = 'simulated';

  private minLatencyMs: number;
  private maxLatencyMs: number;
  private failureRate: number;

  constructor(options: { minLatencyMs?: number; maxLatencyMs?: number; failureRate?: number } = {}) {
    this.minLatencyMs = options.minLatencyMs ?? 100;
    this.maxLatencyMs = options.maxLatencyMs ?? 500;
    this.failureRate = options.failureRate ?? 0;
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const parsed = translationRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: parsed.error.issues.some(issue =>
            issue.path[0] === 'sourceLanguage' || issue.path[0] === 'targetLanguage')
            ? 'INVALID_LANGUAGE' : 'PROVIDER_ERROR',
          message: 'Invalid translation request.',
        },
      };
    }
    const input = parsed.data;
    if (input.simulationMode !== true) {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Simulation mode must be explicitly enabled.' } };
    }
    const startTime = Date.now();
    const latency = this.minLatencyMs + Math.random() * (this.maxLatencyMs - this.minLatencyMs);
    await sleep(latency);
    if (Math.random() < this.failureRate) {
      return {
        success: false,
        error: { code: 'PROVIDER_ERROR', message: 'Mock provider simulated failure', retryAfterMs: 1000 },
      };
    }
    try {
      const sameLanguage = input.sourceLanguage === input.targetLanguage;
      const fragmented = fragmentMessage(input.text, input.channelEmotes, input.fragments);
      const translatedText = sameLanguage ? input.text : restoreFragments(
        this.mockTranslate(fragmented.protectedText, input.targetLanguage), fragmented
      );
      const result: TranslationResult = {
        originalText: input.text,
        translatedText,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        confidence: sameLanguage ? 1 : 0.85,
        latencyMs: Date.now() - startTime,
        provider: this.name,
        provenance: this.provenance,
        cached: false,
      };
      const validated = translationResultSchema.safeParse(result);
      return validated.success
        ? { success: true, result: validated.data }
        : { success: false, error: { code: 'PROVIDER_ERROR', message: 'Invalid simulated translation result.' } };
    } catch {
      return { success: false, error: { code: 'PROVIDER_ERROR', message: 'Protected content could not be restored.' } };
    }
  }

  supportsLanguagePair(source: LanguageCode, target: LanguageCode): boolean {
    return languageCodeSchema.safeParse(source).success && languageCodeSchema.safeParse(target).success;
  }

  getEstimatedCost(_textLength: number): number {
    return 0;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  private mockTranslate(text: string, target: LanguageCode): string {
    const lowerText = text.toLowerCase().trim();
    const translations = Object.hasOwn(MOCK_TRANSLATIONS, lowerText) ? MOCK_TRANSLATIONS[lowerText] : undefined;
    const translated = translations?.[target];
    return translated ?? LANGUAGE_PREFIXES[target] + ' ' + text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let defaultProvider: TranslationProvider | null = null;

export function getTranslationProvider(): TranslationProvider {
  if (!defaultProvider) defaultProvider = new MockTranslationProvider();
  return defaultProvider;
}

export function setTranslationProvider(provider: TranslationProvider): void {
  defaultProvider = provider;
}
