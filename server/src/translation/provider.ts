/**
 * Module C: Internal translation provider contracts.
 * Provider provenance identifies simulation; it does not verify translation quality.
 */
import { z } from 'zod';
import { chatFragmentSchema, countSchema, languageCodeSchema } from '@raidsphere/shared';
import type { ChatFragment, LanguageCode } from '@raidsphere/shared';

export type TranslationProvenance = 'simulated' | 'provider';

export interface TranslationRequest {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  context?: string;
  channelEmotes?: string[];
  fragments?: ChatFragment[];
  simulationMode?: boolean;
}

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  confidence: number;
  latencyMs: number;
  provider: string;
  provenance: TranslationProvenance;
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

export interface TranslationProvider {
  name: string;
  readonly provenance: TranslationProvenance;
  translate(request: TranslationRequest): Promise<TranslationResponse>;
  supportsLanguagePair(source: LanguageCode, target: LanguageCode): boolean;
  getEstimatedCost(textLength: number): number;
  isHealthy(): Promise<boolean>;
}

export const translationRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  sourceLanguage: languageCodeSchema,
  targetLanguage: languageCodeSchema,
  context: z.string().max(2000).optional(),
  channelEmotes: z.array(z.string().min(1).max(2000)).optional(),
  fragments: z.array(chatFragmentSchema).min(1).max(100).optional(),
  simulationMode: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.fragments && value.fragments.map(fragment => fragment.text).join('') !== value.text) {
    context.addIssue({ code: 'custom', path: ['fragments'], message: 'Fragments must reconstruct the original message.' });
  }
});

export const translationResultSchema = z.object({
  originalText: z.string().min(1).max(2000),
  translatedText: z.string().min(1).max(4000),
  sourceLanguage: languageCodeSchema,
  targetLanguage: languageCodeSchema,
  confidence: z.number().min(0).max(1),
  latencyMs: countSchema,
  provider: z.string().min(1).max(128),
  provenance: z.enum(['simulated', 'provider']),
  cached: z.boolean(),
}).strict();

export const translationResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), result: translationResultSchema }).strict(),
  z.object({
    success: z.literal(false),
    error: z.object({
      code: z.enum(['RATE_LIMIT', 'TIMEOUT', 'INVALID_LANGUAGE', 'PROVIDER_ERROR', 'UNKNOWN']),
      message: z.string().min(1).max(200),
      retryAfterMs: countSchema.optional(),
    }).strict(),
  }).strict(),
]);

export interface LanguagePair {
  source: LanguageCode;
  target: LanguageCode;
}

export function getLanguageName(code: LanguageCode): string {
  const names: Record<LanguageCode, string> = {
    en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French',
    de: 'German', ja: 'Japanese', ko: 'Korean',
  };
  return names[code];
}

export function needsTranslation(source: LanguageCode, target: LanguageCode): boolean {
  return source !== target;
}
