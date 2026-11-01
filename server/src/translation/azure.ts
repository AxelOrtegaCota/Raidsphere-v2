/**
 * Module C: Azure AI Translator (Text API v3) as the translation provider and language detector.
 * The key stays on the server: it is read from the environment and never logged or returned.
 * Error messages are fixed and carry no chat content.
 */
import { z } from 'zod';
import { languageCodeSchema } from '@raidsphere/shared';
import type { LanguageCode } from '@raidsphere/shared';
import { fragmentMessage, restoreFragments } from './emotes.js';
import type { FragmentedMessage } from './emotes.js';
import { translationRequestSchema, translationResultSchema } from './provider.js';
import type {
  LanguageDetector, TranslationError, TranslationProvider, TranslationProviderExecutionContext,
  TranslationRequest, TranslationResponse,
} from './provider.js';

const DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';
const REQUEST_TIMEOUT_MS = 8_000;
// shortcut: a fixed threshold, not calibrated on real Twitch chat; tune it after the first live tests.
const DEFAULT_MIN_DETECTION_SCORE = 0.8;

export interface AzureTranslatorConfig {
  key: string;
  // Required for regional and multi-service resources; omitted for a global resource.
  region?: string;
  endpoint?: string;
  minDetectionScore?: number;
  fetch?: typeof fetch;
}

const configSchema = z.object({
  key: z.string().min(1).max(256),
  region: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  endpoint: z.string().url().startsWith('https://').optional(),
  minDetectionScore: z.number().min(0).max(1).optional(),
});

/** Null when no key is configured, so the runtime falls back to the simulated provider. */
export function loadAzureTranslatorConfig(env: {
  AZURE_TRANSLATOR_KEY?: string | undefined; AZURE_TRANSLATOR_REGION?: string | undefined;
}): AzureTranslatorConfig | null {
  if (!env.AZURE_TRANSLATOR_KEY) return null;
  const parsed = configSchema.safeParse({
    key: env.AZURE_TRANSLATOR_KEY,
    ...(env.AZURE_TRANSLATOR_REGION ? { region: env.AZURE_TRANSLATOR_REGION } : {}),
  });
  if (!parsed.success) throw new TypeError('The Azure Translator configuration is invalid.');
  return { key: parsed.data.key, ...(parsed.data.region ? { region: parsed.data.region } : {}) };
}

const translateResponseSchema = z.array(z.object({
  translations: z.array(z.object({ text: z.string(), to: z.string() })).min(1),
})).length(1);

const detectResponseSchema = z.array(z.object({
  language: z.string().min(1).max(32), score: z.number().min(0).max(1),
})).length(1);

export class AzureTranslator implements TranslationProvider, LanguageDetector {
  readonly name = 'azure';
  readonly provenance = 'provider';
  readonly #key: string;
  readonly #region: string | undefined;
  readonly #endpoint: string;
  readonly #minDetectionScore: number;
  readonly #fetch: typeof fetch;

  constructor(config: AzureTranslatorConfig) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new TypeError('The Azure Translator configuration is invalid.');
    this.#key = parsed.data.key;
    this.#region = parsed.data.region;
    this.#endpoint = parsed.data.endpoint ?? DEFAULT_ENDPOINT;
    this.#minDetectionScore = parsed.data.minDetectionScore ?? DEFAULT_MIN_DETECTION_SCORE;
    this.#fetch = config.fetch ?? fetch;
  }

  async translate(request: TranslationRequest, execution: TranslationProviderExecutionContext = {}): Promise<TranslationResponse> {
    const parsed = translationRequestSchema.safeParse(request);
    if (!parsed.success) return failure('INVALID_LANGUAGE', 'Invalid translation request.');
    const input = parsed.data;
    const startedAt = Date.now();
    let fragmented: FragmentedMessage;
    try {
      fragmented = fragmentMessage(input.text, input.channelEmotes, input.fragments);
    } catch {
      return failure('PROVIDER_ERROR', 'The message could not be prepared.');
    }
    const params = new URLSearchParams({
      'api-version': '3.0', from: input.sourceLanguage, to: input.targetLanguage, textType: 'html',
    });
    const response = await this.#post(`/translate?${params}`, toProtectedHtml(fragmented), execution.signal);
    if (!response.ok) return response.error;
    const body = translateResponseSchema.safeParse(response.body);
    const translated = body.success ? body.data[0]?.translations[0]?.text : undefined;
    if (translated === undefined) return failure('PROVIDER_ERROR', 'Unexpected translation response.');
    let translatedText: string;
    try {
      translatedText = restoreFragments(fromProtectedHtml(translated), fragmented);
    } catch {
      return failure('PROVIDER_ERROR', 'Protected content was not preserved.');
    }
    const result = translationResultSchema.safeParse({
      originalText: input.text, translatedText,
      sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage,
      // Azure reports no translation confidence; the field is internal and never published.
      confidence: 1,
      latencyMs: Date.now() - startedAt, provider: this.name, provenance: this.provenance, cached: false,
    });
    return result.success
      ? { success: true, result: result.data }
      : failure('PROVIDER_ERROR', 'Invalid translation result.');
  }

  async detect(text: string): Promise<LanguageCode | null> {
    if (!z.string().min(1).max(2000).safeParse(text).success) throw new TypeError('Invalid detection input.');
    const response = await this.#post('/detect?api-version=3.0', text);
    if (!response.ok) throw new Error('Language detection failed.');
    const body = detectResponseSchema.safeParse(response.body);
    const detected = body.success ? body.data[0] : undefined;
    if (!detected) throw new Error('Unexpected detection response.');
    return detected.score >= this.#minDetectionScore ? toLanguageCode(detected.language) : null;
  }

  supportsLanguagePair(source: LanguageCode, target: LanguageCode): boolean {
    return languageCodeSchema.safeParse(source).success && languageCodeSchema.safeParse(target).success;
  }

  // Billing is per character on Azure; the free tier has no cost to estimate.
  getEstimatedCost(_textLength: number): number {
    return 0;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async #post(path: string, text: string, signal?: AbortSignal):
    Promise<{ ok: true; body: unknown } | { ok: false; error: TranslationResponse }> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${this.#endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.#key,
          ...(this.#region ? { 'Ocp-Apim-Subscription-Region': this.#region } : {}),
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify([{ Text: text }]),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, error: statusFailure(response.status) };
      }
      return { ok: true, body: await response.json() };
    } catch {
      return {
        ok: false,
        error: timeout.aborted ? failure('TIMEOUT', 'The translation provider timed out.')
          : failure('PROVIDER_ERROR', 'The translation provider could not be reached.'),
      };
    }
  }
}

// Azure answers with regional variants such as pt-PT or zh-Hans; only the base language matters here.
export function toLanguageCode(azureCode: string): LanguageCode | null {
  const parsed = languageCodeSchema.safeParse(azureCode.toLowerCase().split('-')[0]);
  return parsed.success ? parsed.data : null;
}

// Placeholders sit inside notranslate spans; all other text is escaped, so chat cannot inject markup.
export function toProtectedHtml(fragmented: FragmentedMessage): string {
  return fragmented.fragments.map((fragment) => fragment.placeholder === undefined
    ? escapeHtml(fragment.value)
    : `<span class="notranslate">${fragment.placeholder}</span>`).join('');
}

export function fromProtectedHtml(html: string): string {
  return unescapeHtml(html.replace(/<span class="notranslate">([^<]*)<\/span>/g, '$1'));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function statusFailure(status: number): TranslationResponse {
  if (status === 429) return failure('RATE_LIMIT', 'The translation provider is rate limited.');
  // 403 also means the free monthly characters are used up.
  if (status === 401 || status === 403) return failure('PROVIDER_ERROR', 'The translation provider rejected the credentials or quota.');
  return failure('PROVIDER_ERROR', 'The translation provider returned an error.');
}

function failure(code: TranslationError['code'], message: string): TranslationResponse {
  return { success: false, error: { code, message } };
}
