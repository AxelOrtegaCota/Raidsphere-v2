/**
 * Tests for Module C: Translation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { translationBubbleSchema, serverEventSchema } from '@raidsphere/shared';
import type { ChatFragment, LanguageCode } from '@raidsphere/shared';
import { translationRequestSchema, translationResponseSchema } from '../translation/provider.js';
import type {
  TranslationProvider, TranslationRequest, TranslationResponse, TranslationProviderExecutionContext,
} from '../translation/provider.js';
import {
  fragmentMessage,
  restoreFragments,
  extractEmotes,
} from '../translation/emotes.js';
import {
  MockTranslationProvider,
} from '../translation/mock-provider.js';
import {
  translateMessage,
  getTranslationMetrics,
  resetTranslationMetrics,
  clearTranslationCache,
  translateMessages,
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
} from '../translation/service.js';
import type { TranslateMessageOptions } from '../translation/service.js';

describe('Emote Preservation', () => {
  describe('fragmentMessage', () => {
    it('should identify common emotes', () => {
      const result = fragmentMessage('Hello Kappa how are you LUL');
      expect(result.fragments).toContainEqual(
        expect.objectContaining({ type: 'emote', value: 'Kappa' })
      );
      expect(result.fragments).toContainEqual(
        expect.objectContaining({ type: 'emote', value: 'LUL' })
      );
    });
    
    it('should protect emotes with placeholders', () => {
      const result = fragmentMessage('Pog play!');
      expect(result.protectedText).toContain('_EMOTE_');
      expect(result.protectedText).not.toContain('Pog');
    });
    
    it('should identify URLs', () => {
      const result = fragmentMessage('Check https://twitch.tv/user');
      expect(result.fragments).toContainEqual(
        expect.objectContaining({ type: 'url', value: 'https://twitch.tv/user' })
      );
    });
    
    it('should identify mentions', () => {
      const result = fragmentMessage('Hey @streamer nice stream');
      expect(result.fragments).toContainEqual(
        expect.objectContaining({ type: 'mention', value: '@streamer' })
      );
    });
    
    it('should identify channel emotes', () => {
      const result = fragmentMessage('Nice channelPog play', ['channelPog']);
      expect(result.fragments).toContainEqual(
        expect.objectContaining({ type: 'emote', value: 'channelPog' })
      );
    });
    
    it('should handle plain text without fragments', () => {
      const result = fragmentMessage('hello world');
      // May have some emote-like patterns but no common emotes
      expect(result.original).toBe('hello world');
    });
  });
  
  describe('restoreFragments', () => {
    it('should restore emotes after translation', () => {
      const fragmented = fragmentMessage('Hello Kappa');
      const translated = fragmented.protectedText.replace('Hello', 'Hola');
      const restored = restoreFragments(translated, fragmented);
      expect(restored).toContain('Kappa');
      expect(restored).toContain('Hola');
    });
    
    it('should handle multiple fragments', () => {
      const fragmented = fragmentMessage('Kappa hey @user check https://x.com LUL');
      const restored = restoreFragments(fragmented.protectedText, fragmented);
      expect(restored).toContain('Kappa');
      expect(restored).toContain('@user');
      expect(restored).toContain('https://x.com');
      expect(restored).toContain('LUL');
    });
  });
  
  describe('extractEmotes', () => {
    it('should return list of emotes', () => {
      const emotes = extractEmotes('Kappa Pog LUL');
      expect(emotes).toContain('Kappa');
      expect(emotes).toContain('Pog');
      expect(emotes).toContain('LUL');
    });
  });
});

describe('Mock Translation Provider', () => {
  let provider: MockTranslationProvider;
  
  beforeEach(() => {
    provider = new MockTranslationProvider({
      minLatencyMs: 10,
      maxLatencyMs: 20,
    });
  });
  
  it('should translate using mock dictionary', async () => {
    const response = await provider.translate({
      simulationMode: true,
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'es',
    });
    
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.result.translatedText).toBe('hola');
    }
  });
  
  it('recognizes dictionary phrases in their source language', async () => {
    const translate = async (text: string, sourceLanguage: LanguageCode, targetLanguage: LanguageCode) => {
      const response = await provider.translate({ simulationMode: true, text, sourceLanguage, targetLanguage });
      return response.success ? response.result.translatedText : null;
    };
    expect(await translate('hola a todos', 'es', 'ja')).toBe('みなさんこんにちは');
    expect(await translate('boa live', 'pt', 'ja')).toBe('いい配信');
    expect(await translate('Bonjour le chat !', 'fr', 'en')).toBe('hello chat');
    expect(await translate('¿Cómo estás?', 'es', 'en')).toBe('how are you');
    // A phrase is matched in its stated language only.
    expect(await translate('hola a todos', 'fr', 'ja')).toBe('[JA] hola a todos');
  });

  it('should add language prefix for unknown text', async () => {
    const response = await provider.translate({
      simulationMode: true,
      text: 'random unique text xyz',
      sourceLanguage: 'en',
      targetLanguage: 'es',
    });
    
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.result.translatedText).toContain('[ES]');
    }
  });
  
  it('should preserve emotes during translation', async () => {
    const response = await provider.translate({
      simulationMode: true,
      text: 'hello Kappa friend',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      channelEmotes: [],
    });
    
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.result.translatedText).toContain('Kappa');
    }
  });
  
  it('should return same text for same language', async () => {
    const response = await provider.translate({
      simulationMode: true,
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'en',
    });
    
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.result.translatedText).toBe('hello');
      expect(response.result.confidence).toBe(1.0);
    }
  });
  
  it('should simulate failures when configured', async () => {
    const failProvider = new MockTranslationProvider({
      minLatencyMs: 10,
      maxLatencyMs: 20,
      failureRate: 1, // Always fail
    });
    
    const response = await failProvider.translate({
      simulationMode: true,
      text: 'test',
      sourceLanguage: 'en',
      targetLanguage: 'es',
    });
    
    expect(response.success).toBe(false);
  });
  
  it('should support all language pairs', () => {
    expect(provider.supportsLanguagePair('en', 'es')).toBe(true);
    expect(provider.supportsLanguagePair('ja', 'ko')).toBe(true);
  });
  
  it('should report zero cost', () => {
    expect(provider.getEstimatedCost(100)).toBe(0);
  });
  
  it('should report healthy', async () => {
    expect(await provider.isHealthy()).toBe(true);
  });
});

describe('Translation Service', () => {
  beforeEach(() => {
    resetTranslationMetrics();
    clearTranslationCache();
  });
  
  const baseOptions = {
    channelId: 'fixture-channel',
    receivedAtMs: 1000,
    simulationMode: true,
    messageId: 'msg_001',
    userId: 'user_001',
    displayName: 'TestUser',
    text: 'hello',
    sourceLanguage: 'en' as const,
    targetLanguage: 'es' as const,
  };
  
  it('should translate a message', async () => {
    const bubble = await translateMessage(baseOptions);
    
    expect(bubble).not.toBeNull();
    expect(bubble?.status).toBe('completed');
    if (bubble?.status === 'completed') {
      expect(bubble.translated).toBe('hola');
    }
    expect(bubble?.toLanguage).toBe('es');
  });
  
  it('should return null for same language', async () => {
    const bubble = await translateMessage({
      ...baseOptions,
      targetLanguage: 'en',
    });
    
    expect(bubble).toBeNull();
  });
  
  it('should cache translations', async () => {
    // First call
    await translateMessage(baseOptions);
    
    // Second call with same text
    await translateMessage({ ...baseOptions, messageId: 'msg_002' });
    
    const metrics = getTranslationMetrics();
    expect(metrics.cacheHits).toBe(1);
  });
  
  it('should track metrics', async () => {
    await translateMessage(baseOptions);
    
    const metrics = getTranslationMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.successCount).toBe(1);
    expect(metrics.averageLatencyMs).toBeGreaterThan(0);
  });
  
  it('should preserve emotes in translation', async () => {
    const bubble = await translateMessage({
      ...baseOptions,
      text: 'hello Kappa friend',
    });
    
    expect(bubble?.status).toBe('completed');
    if (bubble?.status === 'completed') {
      expect(bubble.translated).toContain('Kappa');
    }
  });
  
  it('should include proper bubble structure', async () => {
    const bubble = await translateMessage(baseOptions);
    
    expect(bubble).toMatchObject({
      messageId: 'msg_001',
      userId: 'user_001',
      displayName: 'TestUser',
      original: 'hello',
      toLanguage: 'es',
    });
    expect(bubble?.fragments).toBeDefined();
    expect(bubble?.receivedAtMs).toBeGreaterThan(0);
  });
});

describe('Batch 2 protected fragment integrity', () => {
  it.each([
    '  Kappa\t@fixture_user\nhttps://example.com/$&/$' + "'" + '/$' + String.fromCharCode(96) + '/$$  ',
    'Kappa Kappa LUL',
    '__EMOTE_0__ __RAIDSPHERE_0_EMOTE_0__ Kappa',
    'こんにちは 👩🏽‍💻 🇯🇵 1️⃣ café\n@fixture_user',
    'EZ Clap',
  ])('round-trips protected content exactly: %s', text => {
    const fragmented = fragmentMessage(text);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
    expect(fragmented.fragments.map(fragment => fragment.value).join('')).toBe(text);
  });

  it('retains authoritative fragment identity and order without creating identifiers', () => {
    const fragments: ChatFragment[] = [
      { type: 'text', text: 'Hi ' },
      { type: 'emote', text: 'customtoken', emoteId: 'fixture-emote' },
      { type: 'text', text: ' ' },
      { type: 'mention', text: '@fixture_user', userId: 'fixture-user' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'https://example.com/$&' },
    ];
    const text = fragments.map(fragment => fragment.text).join('');
    const fragmented = fragmentMessage(text, [], fragments);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
    expect(fragmented.fragments.filter(fragment => fragment.placeholder).map(fragment => fragment.sourceFragment))
      .toEqual([fragments[1], fragments[3], fragments[5]]);
    expect(fragmentMessage('Kappa').fragments.some(fragment =>
      fragment.sourceFragment?.type === 'emote')).toBe(false);
  });

  it('rejects missing, duplicated, unexpected, and reordered placeholders', () => {
    const fragmented = fragmentMessage('Kappa @fixture_user');
    const tokens = fragmented.fragments.flatMap(fragment =>
      fragment.placeholder === undefined ? [] : [fragment.placeholder]);
    const first = tokens[0];
    const second = tokens[1];
    if (first === undefined || second === undefined) throw new Error('Fixture must contain two placeholders.');
    for (const corrupted of [
      fragmented.protectedText.replace(first, ''),
      fragmented.protectedText + first,
      fragmented.protectedText + '__RAIDSPHERE_999_UNKNOWN_0__',
      second + ' ' + first,
    ]) {
      expect(() => restoreFragments(corrupted, fragmented)).toThrow('Protected fragment integrity check failed.');
    }
  });

  it('rejects inconsistent source fragments', () => {
    expect(() => fragmentMessage('Hello', [], [{ type: 'text', text: 'Other' }])).toThrow(TypeError);
  });
});

describe('Batch 2 translation service validation and isolation', () => {
  const base: TranslateMessageOptions = {
    channelId: 'fixture-channel-a', receivedAtMs: 1234,
    messageId: 'fixture-message', userId: 'fixture-user', displayName: 'Fixture User',
    text: 'hello', sourceLanguage: 'en', targetLanguage: 'es',
  };

  function createProvider(provenance: 'simulated' | 'provider' = 'provider') {
    return {
      name: 'fixture-provider',
      provenance,
      translate: vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => ({
        success: true,
        result: {
          originalText: request.text, translatedText: 'translated: ' + request.text,
          sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
          confidence: 1, latencyMs: 0, provider: 'fixture-provider', provenance, cached: false,
        },
      })),
      supportsLanguagePair: vi.fn(() => true),
      getEstimatedCost: () => 0,
      isHealthy: async () => true,
    } satisfies TranslationProvider;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clearTranslationCache();
    resetTranslationMetrics();
  });

  afterEach(() => {
    clearTranslationCache();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reconstructs cache hits from current identity, receipt time, and fragments', async () => {
    const provider = createProvider();
    const fragments: ChatFragment[] = [{ type: 'text', text: 'hello' }];
    await translateMessage({ ...base, fragments }, provider);
    const current = {
      ...base, messageId: 'fixture-next-message', userId: 'fixture-next-user',
      displayName: 'Next User', receivedAtMs: 5678, fragments,
    };
    const bubble = await translateMessage(current, provider);
    expect(provider.translate).toHaveBeenCalledTimes(1);
    expect(bubble).toMatchObject({
      original: current.text, messageId: current.messageId, userId: current.userId,
      displayName: current.displayName, receivedAtMs: current.receivedAtMs, fragments,
    });
    expect(translationBubbleSchema.parse(bubble)).toEqual(bubble);
  });

  it('preserves emote and mention identities on cache hits', async () => {
    const provider = createProvider();
    const fragments: ChatFragment[] = [
      { type: 'emote', text: 'Kappa', emoteId: 'fixture-emote' },
      { type: 'text', text: ' ' },
      { type: 'mention', text: '@fixture_user', userId: 'fixture-mentioned-user' },
    ];
    const options = { ...base, text: 'Kappa @fixture_user', fragments };
    await translateMessage(options, provider);
    const bubble = await translateMessage({ ...options, messageId: 'fixture-next-message', receivedAtMs: 9876 }, provider);
    expect(provider.translate).toHaveBeenCalledTimes(1);
    expect(bubble?.fragments).toEqual(fragments);
    expect(bubble?.receivedAtMs).toBe(9876);
  });

  it('does not merge case-sensitive or whitespace-distinct messages', async () => {
    const provider = createProvider();
    for (const text of ['hello', 'HELLO', ' hello ', 'hello\n']) {
      const bubble = await translateMessage({ ...base, text }, provider);
      expect(bubble?.original).toBe(text);
      expect(bubble?.fragments).toEqual([{ type: 'text', text }]);
    }
    expect(provider.translate).toHaveBeenCalledTimes(4);
  });

  it('isolates channels, provider instances, language pairs, emotes, and fragments', async () => {
    const first = createProvider();
    const second = createProvider();
    await translateMessage(base, first);
    await translateMessage({ ...base, channelId: 'fixture-channel-b' }, first);
    await translateMessage({ ...base, targetLanguage: 'fr' }, first);
    await translateMessage({ ...base, sourceLanguage: 'pt' }, first);
    await translateMessage({ ...base, channelEmotes: ['fixtureEmote'] }, first);
    await translateMessage({ ...base, fragments: [{ type: 'text', text: 'hello' }] }, first);
    await translateMessage(base, second);
    expect(first.translate).toHaveBeenCalledTimes(6);
    expect(second.translate).toHaveBeenCalledTimes(1);
  });

  it('preserves independent cache entries after concurrent initial requests', async () => {
    const provider = createProvider();
    await Promise.all([
      translateMessage(base, provider),
      translateMessage({ ...base, text: 'other' }, provider),
    ]);
    await translateMessage(base, provider);
    await translateMessage({ ...base, text: 'other' }, provider);
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });

  it('snapshots caller and provider-visible fragments before asynchronous completion', async () => {
    const provider = createProvider();
    const fragments: ChatFragment[] = [{ type: 'text', text: 'hello' }];
    provider.translate.mockImplementationOnce(async (request): Promise<TranslationResponse> => {
      request.fragments?.splice(0);
      return {
        success: true,
        result: {
          originalText: 'hello', translatedText: 'hola', sourceLanguage: 'en', targetLanguage: 'es',
          confidence: 1, latencyMs: 0, provider: provider.name, provenance: provider.provenance, cached: false,
        },
      };
    });
    const pending = translateMessage({ ...base, fragments }, provider);
    fragments.splice(0);
    const bubble = await pending;
    expect(bubble?.fragments).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('does not assume English for unknown source language', async () => {
    const provider = createProvider();
    const bubble = await translateMessage({ ...base, sourceLanguage: null, targetLanguage: 'en' }, provider);
    expect(bubble).toMatchObject({
      status: 'unavailable', reason: 'unsupported_language', fromLanguage: null, receivedAtMs: base.receivedAtMs,
    });
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it('preserves same-language skipping', async () => {
    const provider = createProvider();
    expect(await translateMessage({ ...base, targetLanguage: 'en' }, provider)).toBeNull();
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it('requires simulation opt-in before invoking or reusing simulated results', async () => {
    const provider = createProvider('simulated');
    expect(await translateMessage(base, provider)).toMatchObject({ status: 'unavailable', reason: 'provider_error' });
    expect(provider.translate).not.toHaveBeenCalled();
    const simulated = await translateMessage({ ...base, simulationMode: true }, provider);
    expect(simulated).toMatchObject({ status: 'completed' });
    expect(simulated).not.toHaveProperty('provenance');
    expect(simulated).not.toHaveProperty('provider');
    expect(await translateMessage(base, provider)).toMatchObject({ status: 'unavailable' });
    expect(provider.translate).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to simulation when a provider fails', async () => {
    const provider = createProvider();
    provider.translate.mockResolvedValueOnce({
      success: false, error: { code: 'PROVIDER_ERROR', message: 'Fixture failure.' },
    });
    expect(await translateMessage({ ...base, simulationMode: true }, provider))
      .toMatchObject({ status: 'unavailable', reason: 'provider_error', translated: null });
    expect(provider.translate).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported provider language pairs without invoking translation', async () => {
    const provider = createProvider();
    provider.supportsLanguagePair.mockReturnValueOnce(false);
    expect(await translateMessage(base, provider)).toMatchObject({ status: 'unavailable', reason: 'unsupported_language' });
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid receipt timestamp %s', async receivedAtMs => {
      const provider = createProvider();
      await expect(translateMessage({ ...base, receivedAtMs }, provider)).rejects.toThrow(TypeError);
      expect(provider.translate).not.toHaveBeenCalled();
    }
  );

  it('accepts the canonical zero timestamp without replacing it', async () => {
    expect(await translateMessage({ ...base, receivedAtMs: 0 }, createProvider())).toMatchObject({ receivedAtMs: 0 });
  });

  it('rejects invalid identifiers, text lengths, and fragment reconstruction', async () => {
    const provider = createProvider();
    for (const invalid of [
      { ...base, channelId: '' }, { ...base, messageId: 'x'.repeat(129) },
      { ...base, userId: '' }, { ...base, displayName: 'x'.repeat(101) },
      { ...base, text: '' }, { ...base, text: 'x'.repeat(2001) },
      { ...base, fragments: [{ type: 'text' as const, text: 'other' }] },
      { ...base, text: 'hello world', fragments: [
        { type: 'text' as const, text: 'world' }, { type: 'text' as const, text: 'hello ' },
      ] },
      { ...base, text: 'a'.repeat(101), fragments: Array.from({ length: 101 }, () => ({ type: 'text' as const, text: 'a' })) },
      { ...base, text: 'Kappa', fragments: [{ type: 'emote' as const, text: 'Kappa', emoteId: '' }] },
    ]) {
      await expect(translateMessage(invalid, provider)).rejects.toThrow(TypeError);
    }
    expect(provider.translate).not.toHaveBeenCalled();
  });


  it('accepts canonical text, identifier, display-name, and result length boundaries', async () => {
    const provider = createProvider();
    const options = {
      ...base, channelId: 'c'.repeat(128), messageId: 'm'.repeat(128), userId: 'u'.repeat(128),
      displayName: 'd'.repeat(100), text: 'x'.repeat(2000),
    };
    provider.translate.mockResolvedValueOnce({
      success: true,
      result: {
        originalText: options.text, translatedText: 'y'.repeat(4000),
        sourceLanguage: 'en', targetLanguage: 'es', confidence: 1, latencyMs: 0,
        provider: provider.name, provenance: provider.provenance, cached: false,
      },
    });
    const bubble = await translateMessage(options, provider);
    expect(bubble).toMatchObject({ status: 'completed', original: options.text, translated: 'y'.repeat(4000) });
    expect(translationBubbleSchema.parse(bubble)).toEqual(bubble);
  });

  it.each([
    { translatedText: '' }, { translatedText: 'x'.repeat(4001) },
    { originalText: 'different' }, { sourceLanguage: 'fr' }, { targetLanguage: 'de' },
    { confidence: 2 }, { latencyMs: -1 }, { provider: 'different-provider' },
    { provenance: 'simulated' }, { cached: 'not-a-boolean' }, { unexpected: 'field' },
  ])('rejects malformed or mismatched provider result %j', async changes => {
    const provider = createProvider();
    const response = {
      success: true,
      result: {
        originalText: base.text, translatedText: 'hola', sourceLanguage: 'en', targetLanguage: 'es',
        confidence: 1, latencyMs: 0, provider: provider.name, provenance: provider.provenance, cached: false,
        ...changes,
      },
    };
    // Deserialization deliberately models untrusted runtime provider data, without type assertions.
    provider.translate.mockResolvedValueOnce(JSON.parse(JSON.stringify(response)));
    const bubble = await translateMessage(base, provider);
    expect(bubble).toMatchObject({ status: 'unavailable', reason: 'provider_error', translated: null });
    expect(translationBubbleSchema.parse(bubble)).toEqual(bubble);
    await translateMessage(base, provider);
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });

  it('contains thrown provider errors without exposing their text in public output', async () => {
    const provider = createProvider();
    provider.translate.mockRejectedValueOnce(new Error('Synthetic private diagnostic.'));
    const bubble = await translateMessage(base, provider);
    expect(bubble).toMatchObject({ status: 'unavailable', reason: 'provider_error' });
    expect(JSON.stringify(bubble)).not.toContain('Synthetic private diagnostic.');
  });

  it('produces valid completed, unavailable, and batch event payloads', async () => {
    const provider = createProvider();
    const results = await translateMessages([base, { ...base, messageId: 'fixture-unknown', sourceLanguage: null }], provider);
    expect(results).toHaveLength(2);
    expect(results.map(result => result?.status)).toEqual(['completed', 'unavailable']);
    for (const payload of results) {
      expect(serverEventSchema.safeParse({
        version: 1, type: 'translate:bubble', eventId: '00000000-0000-4000-8000-000000000001',
        channelId: base.channelId, sequence: 1, occurredAtMs: 5678, payload,
      }).success).toBe(true);
    }
  });
});

describe('Batch 2 provider runtime boundaries', () => {
  const request: TranslationRequest = {
    text: 'hello', sourceLanguage: 'en', targetLanguage: 'es', simulationMode: true,
  };

  it('requires explicit simulation even when the mock is called directly', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 0, maxLatencyMs: 0 });
    expect(await provider.translate({ ...request, simulationMode: false })).toMatchObject({ success: false });
    const { simulationMode: _simulationMode, ...withoutOptIn } = request;
    expect(await provider.translate(withoutOptIn)).toMatchObject({ success: false });
  });

  it('marks prefix output as simulated provider data', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 0, maxLatencyMs: 0 });
    const response = await provider.translate({ ...request, text: 'uncatalogued phrase' });
    expect(response).toMatchObject({
      success: true, result: { provenance: 'simulated', provider: 'mock', translatedText: '[ES] uncatalogued phrase' },
    });
    expect(translationResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects unsupported languages and oversized requests at runtime', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 0, maxLatencyMs: 0 });
    const unsupported = JSON.parse(JSON.stringify({ ...request, sourceLanguage: 'unsupported' }));
    expect(translationRequestSchema.safeParse(unsupported).success).toBe(false);
    expect(await provider.translate(unsupported)).toMatchObject({ success: false, error: { code: 'INVALID_LANGUAGE' } });
    expect(await provider.translate({ ...request, text: 'x'.repeat(2001) })).toMatchObject({ success: false });
  });
});

describe('Batch 2 literal markers and canonical fragment boundaries', () => {
  it.each([
    '__RAIDSPHERE_0_😀',
    '__RAIDSPHERE_0_EMOTE_0😀',
    '__RAIDSPHERE_0_EMOTE_0_😀',
    '__RAIDSPHERE_0_EMOTE_0__😀',
    '__RAIDSPHERE_😀👩🏽‍💻',
    '__RAIDSPHERE_0_@fixture_user',
    '__RAIDSPHERE_https://example.com/$&',
    '__RAIDSPHERE_0_ Kappa __RAIDSPHERE_1_😀',
    '__RAIDSPHERE_0_EMOTE_0____RAIDSPHERE_1_EMOTE_1__😀',
  ])('preserves literal prefixes beside protected content: %s', text => {
    const fragmented = fragmentMessage(text);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
    expect(restoreFragments('translated: ' + fragmented.protectedText, fragmented)).toBe('translated: ' + text);
    expect(fragmented.fragments.map(fragment => fragment.value).join('')).toBe(text);
    const tokens = fragmented.fragments.flatMap(fragment =>
      fragment.placeholder === undefined ? [] : [fragment.placeholder]);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(fragmented.protectedText.match(/__RAIDSPHERE_[0-9]+_[A-Z]+_[0-9]+__/g)).toEqual(tokens);
  });

  it.each([
    '__RAIDSPHERE_0_EMOTE_0__',
    '__RAIDSPHERE_0_😀',
    'https://example.com/$&/__RAIDSPHERE_0_EMOTE_0__',
    '__RAIDSPHERE_https://example.com/$&',
    'PogChamp',
    'CustomToken',
    '@fixture_user',
    ' \t👩🏽‍💻 🇯🇵 1️⃣\n',
  ])('preserves content at every interior text-fragment split: %s', text => {
    const unsplit = fragmentMessage(text);
    for (let split = 1; split < text.length; split++) {
      const fragments: ChatFragment[] = [
        { type: 'text', text: text.slice(0, split) },
        { type: 'text', text: text.slice(split) },
      ];
      const original = structuredClone(fragments);
      const fragmented = fragmentMessage(text, [], fragments);
      expect(fragmented.protectedText).toBe(unsplit.protectedText);
      expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
      expect(fragmented.sourceFragments).toEqual(original);
      expect(fragments).toEqual(original);
      expect(fragmented.fragments.map(fragment => fragment.value).join('')).toBe(text);
      expect(fragmented.fragments.some(fragment => fragment.sourceFragment?.type === 'emote')).toBe(false);
    }
  });

  it('retains the exact canonical partition when a marker spans many fragments', () => {
    const text = '__RAIDSPHERE_0_EMOTE_0__';
    const fragments: ChatFragment[] = Array.from(text, character => ({ type: 'text', text: character }));
    const fragmented = fragmentMessage(text, [], fragments);
    expect(fragmented.protectedText).toBe(fragmentMessage(text).protectedText);
    expect(fragmented.sourceFragments).toEqual(fragments);
    expect(fragmented.sourceFragments).not.toBe(fragments);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
    // A spanning token must not claim that it belongs to just one source fragment.
    expect(fragmented.fragments.filter(fragment => fragment.placeholder).map(fragment => fragment.sourceFragment))
      .toEqual([undefined]);
    fragments.splice(0);
    expect(fragmented.sourceFragments?.map(fragment => fragment.text).join('')).toBe(text);
  });

  it('preserves authoritative identities directly adjacent to an incomplete literal', () => {
    const fragments: ChatFragment[] = [
      { type: 'text', text: '__RAIDSPHERE_0_' },
      { type: 'emote', text: 'customtoken', emoteId: 'fixture-emote' },
      { type: 'mention', text: '@fixture_user', userId: 'fixture-mentioned-user' },
      { type: 'link', text: 'https://example.com/$&' },
      { type: 'text', text: '😀\t ' },
    ];
    const text = fragments.map(fragment => fragment.text).join('');
    const fragmented = fragmentMessage(text, [], fragments);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
    expect(fragmented.sourceFragments).toEqual(fragments);
    expect(fragmented.fragments.filter(fragment => fragment.sourceFragment?.type !== 'text')
      .map(fragment => fragment.sourceFragment)).toEqual(fragments.slice(1, 4));
  });

  it('does not recognize a literal across an authoritative non-text fragment', () => {
    const fragments: ChatFragment[] = [
      { type: 'text', text: '__RAID' },
      { type: 'emote', text: 'SPHERE_', emoteId: 'fixture-emote' },
      { type: 'text', text: '0_EMOTE_0__ ' },
    ];
    const text = fragments.map(fragment => fragment.text).join('');
    const fragmented = fragmentMessage(text, [], fragments);
    expect(fragmented.sourceFragments).toEqual(fragments);
    expect(fragmented.fragments.filter(fragment => fragment.placeholder)).toEqual([
      expect.objectContaining({ type: 'emote', value: 'SPHERE_', sourceFragment: fragments[1] }),
    ]);
    expect(fragmented.protectedText).not.toBe(fragmentMessage(text).protectedText);
    expect(restoreFragments(fragmented.protectedText, fragmented)).toBe(text);
  });

  it('still rejects corrupted, missing, duplicated, reordered, and unexpected generated tokens', () => {
    const fragmented = fragmentMessage('__RAIDSPHERE_0_😀');
    const tokens = fragmented.fragments.flatMap(fragment =>
      fragment.placeholder === undefined ? [] : [fragment.placeholder]);
    const first = tokens[0];
    const second = tokens[1];
    if (first === undefined || second === undefined) throw new Error('Fixture must contain two placeholders.');
    for (const output of [
      fragmented.protectedText.replace(first, ''),
      fragmented.protectedText + first,
      second + first,
      fragmented.protectedText.replace(first, first.slice(0, -1)),
      fragmented.protectedText.replace(first, first.replace('_TEXT_', '_text_')),
      fragmented.protectedText + '__RAIDSPHERE_999_UNKNOWN_0__',
      fragmented.protectedText + '__RAIDSPHERE_999_',
      '__RAIDSPHERE_999_BROKEN__ ' + fragmented.protectedText,
    ]) {
      expect(() => restoreFragments(output, fragmented)).toThrow('Protected fragment integrity check failed.');
    }
  });
});

describe('Batch 2 split-fragment simulation compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTranslationCache();
    resetTranslationMetrics();
  });

  afterEach(() => {
    clearTranslationCache();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    '__RAIDSPHERE_0_😀',
    '__RAIDSPHERE_0_EMOTE_0__',
    'https://example.com/$& PogChamp 👩🏽‍💻\t',
  ])('preserves source structure through explicitly enabled simulation: %s', async text => {
    const fragments: ChatFragment[] = Array.from(text, character => ({ type: 'text', text: character }));
    const provider = new MockTranslationProvider({ minLatencyMs: 0, maxLatencyMs: 0 });
    const options: TranslateMessageOptions = {
      channelId: 'fixture-channel', receivedAtMs: 1234,
      messageId: 'fixture-message', userId: 'fixture-user', displayName: 'Fixture User',
      text, fragments, sourceLanguage: 'en', targetLanguage: 'es', simulationMode: true,
    };
    const pending = translateMessage(options, provider);
    await vi.advanceTimersByTimeAsync(0);
    const bubble = await pending;
    expect(bubble).toMatchObject({
      status: 'completed', original: text, translated: '[ES] ' + text,
      fragments, receivedAtMs: 1234,
    });
    expect(translationBubbleSchema.parse(bubble)).toEqual(bubble);
    expect(bubble).not.toHaveProperty('sourceFragments');
    expect(bubble).not.toHaveProperty('provenance');
    expect(await translateMessage({ ...options, simulationMode: false }, provider))
      .toMatchObject({ status: 'unavailable', reason: 'provider_error' });
  });
});

describe('Batch 3B translation lifecycle and physical concurrency', () => {
  const base: TranslateMessageOptions = {
    channelId: 'lifecycle-channel', receivedAtMs: 1234,
    messageId: 'lifecycle-message', userId: 'lifecycle-user', displayName: 'Fixture User',
    text: 'hello', sourceLanguage: 'en', targetLanguage: 'es',
  };

  interface DeferredCall {
    request: TranslationRequest;
    signal: AbortSignal | undefined;
    settled: boolean;
    resolve: () => void;
    reject: () => void;
  }

  const ownedCalls: DeferredCall[] = [];
  const ownedControllers: AbortController[] = [];
  let physicalOperations = 0;
  let peakPhysicalOperations = 0;

  function message(index: number, changes: Partial<TranslateMessageOptions> = {}): TranslateMessageOptions {
    return { ...base, messageId: 'message-' + index, text: 'text-' + index, ...changes };
  }

  function success(request: TranslationRequest): TranslationResponse {
    return {
      success: true,
      result: {
        originalText: request.text, translatedText: 'translated: ' + request.text,
        sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
        confidence: 1, latencyMs: 0, provider: 'lifecycle-provider', provenance: 'provider', cached: false,
      },
    };
  }

  function immediateProvider() {
    return {
      name: 'lifecycle-provider', provenance: 'provider',
      translate: vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => success(request)),
      supportsLanguagePair: vi.fn(() => true),
      getEstimatedCost: () => 0,
      isHealthy: async () => true,
    } satisfies TranslationProvider;
  }

  function controlledProvider(cooperative = false) {
    const calls: DeferredCall[] = [];
    let active = 0;
    let peak = 0;
    const provider = {
      name: 'lifecycle-provider', provenance: 'provider',
      translate: vi.fn((request: TranslationRequest, execution: TranslationProviderExecutionContext = {}): Promise<TranslationResponse> => {
        active++;
        peak = Math.max(peak, active);
        physicalOperations++;
        peakPhysicalOperations = Math.max(peakPhysicalOperations, physicalOperations);
        let resolveResponse: (response: TranslationResponse) => void = () => {};
        let rejectResponse: (error: Error) => void = () => {};
        const pending = new Promise<TranslationResponse>((resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        });
        const call: DeferredCall = {
          request, signal: execution.signal, settled: false,
          resolve: () => {
            if (call.settled) return;
            call.settled = true;
            resolveResponse(success(request));
          },
          reject: () => {
            if (call.settled) return;
            call.settled = true;
            rejectResponse(new Error('Synthetic provider rejection.'));
          },
        };
        calls.push(call);
        ownedCalls.push(call);
        const onAbort = () => { call.reject(); };
        if (cooperative) {
          execution.signal?.addEventListener('abort', onAbort, { once: true });
          if (execution.signal?.aborted) onAbort();
        }
        return pending.finally(() => {
          active--;
          physicalOperations--;
          if (cooperative) execution.signal?.removeEventListener('abort', onAbort);
        });
      }),
      supportsLanguagePair: vi.fn(() => true),
      getEstimatedCost: () => 0,
      isHealthy: async () => true,
    } satisfies TranslationProvider;
    return { provider, calls, active: () => active, peak: () => peak };
  }

  function callAt(calls: DeferredCall[], index: number): DeferredCall {
    const call = calls[index];
    if (!call) throw new Error('Expected provider invocation is missing.');
    return call;
  }

  function controller(): AbortController {
    const value = new AbortController();
    ownedControllers.push(value);
    return value;
  }

  // Drain the bounded promise chain without advancing deadlines or using sleeps.
  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  }

  async function settleAll(): Promise<void> {
    for (let round = 0; round < 110; round++) {
      for (const call of ownedCalls) call.resolve();
      await flushMicrotasks();
      if (ownedCalls.every(call => call.settled) && getTranslationSchedulerState().occupiedSlots === 0) return;
    }
    throw new Error('Deferred provider operations did not drain.');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    ownedCalls.length = 0;
    ownedControllers.length = 0;
    expect(physicalOperations).toBe(0);
    peakPhysicalOperations = 0;
    resumeTranslationService();
    clearTranslationCache();
    resetTranslationMetrics();
    expect(getTranslationSchedulerState()).toMatchObject({
      occupiedSlots: 0, queuedJobs: 0, retainedJobs: 0, activeSessions: 0,
    });
  });

  afterEach(async () => {
    try {
      disposeTranslationService();
      for (const value of ownedControllers) value.abort();
      await settleAll();
      expect(getTranslationSchedulerState()).toMatchObject({
        occupiedSlots: 0, unresolvedProviderOperations: 0, detachedOperations: 0,
        queuedJobs: 0, retainedJobs: 0, activeSessions: 0, cacheEntries: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(physicalOperations).toBe(0);
    } finally {
      clearTranslationCache();
      resumeTranslationService();
      resetTranslationMetrics();
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('shares five physical permits across individual calls, batches, and provider instances', async () => {
    const first = controlledProvider();
    const second = controlledProvider();
    const individual = [0, 1, 2].map(index => translateMessage(message(index), first.provider));
    const batchA = translateMessages([3, 4, 5, 6].map(index => message(index)), first.provider);
    const batchB = translateMessages([7, 8, 9, 10].map(index => message(index)), second.provider);
    expect(first.active() + second.active()).toBe(5);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 6 });
    callAt(first.calls, 0).resolve();
    await flushMicrotasks();
    expect(first.calls.map(call => call.request.text)).toEqual([0, 1, 2, 3, 4, 5].map(index => 'text-' + index));
    expect(first.active() + second.active()).toBe(5);
    await settleAll();
    expect((await Promise.all(individual)).map(result => result?.messageId)).toEqual(['message-0', 'message-1', 'message-2']);
    expect((await batchA).map(result => result?.messageId)).toEqual(['message-3', 'message-4', 'message-5', 'message-6']);
    expect((await batchB).map(result => result?.messageId)).toEqual(['message-7', 'message-8', 'message-9', 'message-10']);
    expect(first.peak()).toBeLessThanOrEqual(5);
    expect(second.peak()).toBeLessThanOrEqual(5);
    expect(peakPhysicalOperations).toBe(5);
    expect(getTranslationMetrics().successCount).toBe(11);
  });

  it('bounds the queue at 100 and expires queued jobs without invoking the provider', async () => {
    const fixture = controlledProvider();
    const running = [0, 1, 2, 3, 4].map(index => translateMessage(message(index), fixture.provider));
    const queued = translateMessages(Array.from({ length: 100 }, (_, index) => message(index + 5)), fixture.provider);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 100, retainedJobs: 105 });
    expect(await translateMessage(message(105), fixture.provider)).toMatchObject({ status: 'unavailable', reason: 'capacity' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(getTranslationSchedulerState().queuedJobs).toBe(100);
    await vi.advanceTimersByTimeAsync(1);
    expect((await queued).every(result => result?.status === 'unavailable' && result.reason === 'timeout')).toBe(true);
    expect(fixture.provider.translate).toHaveBeenCalledTimes(5);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 0 });
    await settleAll();
    expect((await Promise.all(running)).every(result => result?.status === 'completed')).toBe(true);
  });

  it('retains permits after provider deadlines until late fulfillment or rejection settles physically', async () => {
    const fixture = controlledProvider();
    const pending = [0, 1, 2, 3, 4].map(index => translateMessage(message(index), fixture.provider));
    await vi.advanceTimersByTimeAsync(9999);
    expect(getTranslationSchedulerState().detachedOperations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await Promise.all(pending)).every(result => result?.status === 'unavailable' && result.reason === 'timeout')).toBe(true);
    expect(fixture.calls.every(call => call.signal?.aborted)).toBe(true);
    expect(getTranslationSchedulerState()).toMatchObject({
      occupiedSlots: 5, unresolvedProviderOperations: 5, detachedOperations: 5, cacheEntries: 0,
    });
    resetTranslationMetrics();
    clearTranslationCache();
    const next = translateMessage(message(5), fixture.provider);
    expect(fixture.provider.translate).toHaveBeenCalledTimes(5);
    callAt(fixture.calls, 0).reject();
    await flushMicrotasks();
    expect(fixture.provider.translate).toHaveBeenCalledTimes(6);
    expect(fixture.active()).toBe(5);
    for (const call of fixture.calls.slice(1, 5)) call.resolve();
    await flushMicrotasks();
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
    expect(getTranslationMetrics().successCount).toBe(0);
    await settleAll();
    expect(await next).toMatchObject({ status: 'completed', messageId: 'message-5' });
    expect(fixture.peak()).toBe(5);
  });

  it('starts a fresh provider deadline when a queued job is dispatched', async () => {
    const fixture = controlledProvider();
    const running = [0, 1, 2, 3, 4].map(index => translateMessage(message(index), fixture.provider));
    const queued = translateMessage(message(5), fixture.provider);
    await vi.advanceTimersByTimeAsync(4000);
    callAt(fixture.calls, 0).resolve();
    await flushMicrotasks();
    expect(fixture.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(6000);
    expect(getTranslationSchedulerState().detachedOperations).toBe(4);
    await vi.advanceTimersByTimeAsync(3999);
    expect(callAt(fixture.calls, 5).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await queued).toMatchObject({ reason: 'timeout' });
    expect(callAt(fixture.calls, 5).signal?.aborted).toBe(true);
    await Promise.all(running);
    await settleAll();
  });

  it('suppresses pre-aborted and queued calls without starting provider operations', async () => {
    const fixture = controlledProvider();
    const early = controller();
    early.abort();
    expect(await translateMessage(message(0), fixture.provider, { signal: early.signal })).toBeNull();
    expect(fixture.calls).toHaveLength(0);
    const running = [1, 2, 3, 4, 5].map(index => translateMessage(message(index), fixture.provider));
    const waiting = controller();
    const queued = translateMessage(message(6), fixture.provider, { signal: waiting.signal });
    waiting.abort();
    expect(await queued).toBeNull();
    expect(getTranslationSchedulerState().queuedJobs).toBe(0);
    expect(fixture.calls).toHaveLength(5);
    await settleAll();
    await Promise.all(running);
  });

  it.each([false, true])('cancellation releases a permit only on settlement (cooperative=%s)', async cooperative => {
    const fixture = controlledProvider(cooperative);
    const cancel = controller();
    const pending = translateMessage(base, fixture.provider, { signal: cancel.signal });
    cancel.abort();
    expect(getTranslationSchedulerState().occupiedSlots).toBe(1);
    expect(await pending).toBeNull();
    await flushMicrotasks();
    expect(getTranslationSchedulerState().occupiedSlots).toBe(cooperative ? 0 : 1);
    expect(callAt(fixture.calls, 0).signal?.aborted).toBe(true);
    await settleAll();
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
  });

  it('removes caller abort listeners on success and ignores cancellation after delivery', async () => {
    const cancel = controller();
    const add = vi.spyOn(cancel.signal, 'addEventListener');
    const remove = vi.spyOn(cancel.signal, 'removeEventListener');
    const result = await translateMessage(base, immediateProvider(), { signal: cancel.signal });
    expect(result?.status).toBe('completed');
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    cancel.abort();
    expect(result?.status).toBe('completed');
    expect(getTranslationSchedulerState().retainedJobs).toBe(0);
  });

  it.each(['cancel', 'message', 'user', 'channel', 'dispose'] as const)(
    'suppresses a resolved provider result before delivery after %s', async action => {
      const provider = immediateProvider();
      const cancel = controller();
      const pending = translateMessage(base, provider, { signal: cancel.signal });
      // The provider settlement handler is already queued. Invalidation runs
      // before translateMessage's final delivery continuation.
      queueMicrotask(() => {
        if (action === 'cancel') cancel.abort();
        if (action === 'message') invalidateTranslationMessage(base.channelId, base.messageId);
        if (action === 'user') invalidateTranslationUser(base.channelId, base.userId);
        if (action === 'channel') invalidateTranslationChannel(base.channelId);
        if (action === 'dispose') disposeTranslationService();
      });
      expect(await pending).toBeNull();
      expect(getTranslationSchedulerState().cacheEntries).toBe(0);
    }
  );

  it('suppresses a cache hit invalidated before its delivery continuation', async () => {
    const provider = immediateProvider();
    await translateMessage(base, provider);
    const pending = translateMessage({ ...base, messageId: 'cached-message' }, provider);
    invalidateTranslationMessage(base.channelId, 'cached-message');
    expect(await pending).toBeNull();
    expect(provider.translate).toHaveBeenCalledTimes(1);
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
  });

  it.each(['message', 'user', 'channel'] as const)('isolates %s invalidation by channel and target', async kind => {
    const fixture = controlledProvider();
    const matching = translateMessage(base, fixture.provider);
    const otherUser = translateMessage(message(1, { userId: 'other-user' }), fixture.provider);
    const otherChannel = translateMessage({ ...base, channelId: 'other-channel' }, fixture.provider);
    const affected = kind === 'message' ? invalidateTranslationMessage(base.channelId, base.messageId)
      : kind === 'user' ? invalidateTranslationUser(base.channelId, base.userId)
        : invalidateTranslationChannel(base.channelId);
    expect(affected).toBe(kind === 'channel' ? 2 : 1);
    expect(await matching).toBeNull();
    expect(callAt(fixture.calls, 0).signal?.aborted).toBe(true);
    expect(callAt(fixture.calls, 2).signal?.aborted).toBe(false);
    await settleAll();
    expect((await otherUser)?.status ?? null).toBe(kind === 'channel' ? null : 'completed');
    expect(await otherChannel).toMatchObject({ status: 'completed', messageId: base.messageId });
  });

  it('invalidates queued targets as well as running targets before abort callbacks reenter', async () => {
    const fixture = controlledProvider();
    const pending = Array.from({ length: 8 }, (_, index) => translateMessage(message(index), fixture.provider));
    let observedQueue = -1;
    callAt(fixture.calls, 0).signal?.addEventListener('abort', () => {
      observedQueue = getTranslationSchedulerState().queuedJobs;
    });
    expect(invalidateTranslationUser(base.channelId, base.userId)).toBe(8);
    expect(observedQueue).toBe(0);
    expect((await Promise.all(pending)).every(result => result === null)).toBe(true);
    expect(fixture.calls).toHaveLength(5);
    await settleAll();
  });

  it('replaces sessions without allowing old or copied handles to regain eligibility', async () => {
    const fixture = controlledProvider();
    const old = activateTranslationSession(base.channelId, 'session-a');
    const pending = translateMessage(base, fixture.provider, { session: old });
    const next = activateTranslationSession(base.channelId, 'session-b');
    expect(await pending).toBeNull();
    expect(isTranslationSessionActive(old)).toBe(false);
    expect(isTranslationSessionActive(next)).toBe(true);
    expect(await translateMessage(base, fixture.provider, { session: old })).toBeNull();
    expect(await translateMessage(base, fixture.provider)).toBeNull();
    await expect(translateMessage(base, fixture.provider, { session: { ...next } })).rejects.toThrow(TypeError);
    await expect(translateMessage({ ...base, channelId: 'other-channel' }, fixture.provider, { session: next })).rejects.toThrow(TypeError);
    const current = translateMessage(message(1), fixture.provider, { session: next });
    await settleAll();
    expect(await current).toMatchObject({ status: 'completed' });
    const sameIdReplacement = activateTranslationSession(base.channelId, 'session-b');
    expect(isTranslationSessionActive(next)).toBe(false);
    expect(isTranslationSessionActive(sameIdReplacement)).toBe(true);
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
  });

  it('invalidates only the matching channel session and rejects revoked handles after cleanup', async () => {
    const fixture = controlledProvider();
    const first = activateTranslationSession(base.channelId, 'shared-session-name');
    const second = activateTranslationSession('other-channel', 'shared-session-name');
    const a = translateMessage(base, fixture.provider, { session: first });
    const b = translateMessage({ ...base, channelId: 'other-channel' }, fixture.provider, { session: second });
    expect(invalidateTranslationSession(base.channelId, 'different-session')).toBe(0);
    expect(isTranslationSessionActive(first)).toBe(true);
    expect(invalidateTranslationSession(base.channelId, first.sessionId)).toBe(1);
    expect(await a).toBeNull();
    expect(isTranslationSessionActive(first)).toBe(false);
    expect(isTranslationSessionActive(second)).toBe(true);
    expect(await translateMessage(base, fixture.provider, { session: first })).toBeNull();
    await settleAll();
    expect(await b).toMatchObject({ status: 'completed' });
  });

  it('bounds active sessions and allows replacement or explicit channel cleanup at capacity', () => {
    for (let index = 0; index < 100; index++) activateTranslationSession('channel-' + index, 'session-' + index);
    expect(getTranslationSchedulerState().activeSessions).toBe(100);
    expect(() => activateTranslationSession('overflow-channel', 'session')).toThrow(RangeError);
    const replacement = activateTranslationSession('channel-0', 'replacement');
    expect(isTranslationSessionActive(replacement)).toBe(true);
    invalidateTranslationChannel('channel-1');
    expect(() => activateTranslationSession('overflow-channel', 'session')).not.toThrow();
    expect(getTranslationSchedulerState().activeSessions).toBe(100);
  });

  it('contains synchronous throws, rejected promises, metadata errors, and capability errors', async () => {
    for (const boundary of ['translate', 'rejection', 'metadata', 'capability']) {
      const provider = immediateProvider();
      if (boundary === 'translate') provider.translate.mockImplementation(() => { throw new Error('Private fixture detail.'); });
      if (boundary === 'rejection') provider.translate.mockRejectedValue(new Error('Private fixture detail.'));
      if (boundary === 'metadata') Object.defineProperty(provider, 'name', { get: () => { throw new Error('Private fixture detail.'); } });
      if (boundary === 'capability') provider.supportsLanguagePair.mockImplementation(() => { throw new Error('Private fixture detail.'); });
      const bubble = await translateMessage(base, provider);
      expect(bubble).toMatchObject({ status: 'unavailable', reason: 'provider_error' });
      expect(JSON.stringify(bubble)).not.toContain('Private fixture detail.');
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0 });
    }
  });

  it('does not invoke translation after reentrant capability invalidation', async () => {
    const provider = immediateProvider();
    provider.supportsLanguagePair.mockImplementation(() => {
      invalidateTranslationMessage(base.channelId, base.messageId);
      return true;
    });
    expect(await translateMessage(base, provider)).toBeNull();
    expect(provider.translate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the permit when provider invocation reentrantly disposes before returning its promise', async () => {
    const fixture = controlledProvider();
    const provider: TranslationProvider = {
      ...fixture.provider,
      translate: (request, execution) => {
        const pending = fixture.provider.translate(request, execution);
        disposeTranslationService();
        return pending;
      },
    };
    expect(await translateMessage(base, provider)).toBeNull();
    expect(getTranslationSchedulerState()).toMatchObject({ disposed: true, occupiedSlots: 1, detachedOperations: 1 });
    await settleAll();
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
  });

  it('does not reset physical accounting across disposal, resumption, or provider replacement', async () => {
    const fixture = controlledProvider();
    const replacement = controlledProvider();
    const pending = Array.from({ length: 8 }, (_, index) => translateMessage(message(index), fixture.provider));
    let reentrantResume: boolean | undefined;
    callAt(fixture.calls, 0).signal?.addEventListener('abort', () => {
      reentrantResume = resumeTranslationService();
    });
    disposeTranslationService();
    disposeTranslationService();
    expect(reentrantResume).toBe(false);
    expect((await Promise.all(pending)).every(result => result === null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, detachedOperations: 5, queuedJobs: 0 });
    expect(await translateMessage(base, replacement.provider)).toBeNull();
    expect(resumeTranslationService()).toBe(true);
    const next = translateMessage(message(9), replacement.provider);
    expect(replacement.calls).toHaveLength(0);
    callAt(fixture.calls, 0).reject();
    await flushMicrotasks();
    expect(replacement.calls).toHaveLength(1);
    expect(fixture.active() + replacement.active()).toBe(5);
    await settleAll();
    expect(await next).toMatchObject({ status: 'completed' });
  });

  it('prevents cache repopulation by jobs admitted before a cache clear without suppressing valid delivery', async () => {
    const fixture = controlledProvider();
    const pending = translateMessage(base, fixture.provider);
    clearTranslationCache();
    await settleAll();
    expect(await pending).toMatchObject({ status: 'completed' });
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
    const retry = translateMessage(base, fixture.provider);
    expect(fixture.calls).toHaveLength(2);
    await settleAll();
    expect(await retry).toMatchObject({ status: 'completed' });
    expect(getTranslationSchedulerState().cacheEntries).toBe(1);
  });

  it('purges moderated channel cache entries without evicting unrelated channel content', async () => {
    const provider = immediateProvider();
    await translateMessage(base, provider);
    await translateMessage({ ...base, channelId: 'other-channel' }, provider);
    invalidateTranslationMessage(base.channelId, base.messageId);
    expect(getTranslationSchedulerState().cacheEntries).toBe(1);
    await translateMessage({ ...base, channelId: 'other-channel' }, provider);
    expect(provider.translate).toHaveBeenCalledTimes(2);
    // Module D must separately reject re-submission of a durably deleted message.
    await translateMessage({ ...base, messageId: 'new-message' }, provider);
    expect(provider.translate).toHaveBeenCalledTimes(3);
  });

  it('enforces a global 500-entry LRU cache across provider instances', async () => {
    const first = immediateProvider();
    const second = immediateProvider();
    for (let index = 0; index < 500; index++) {
      await translateMessage(message(index), index % 2 === 0 ? first : second);
    }
    expect(getTranslationSchedulerState().cacheEntries).toBe(500);
    expect(first.translate).toHaveBeenCalledTimes(250);
    expect(second.translate).toHaveBeenCalledTimes(250);
    await translateMessage(message(0), first);
    await translateMessage(message(500), first);
    await translateMessage(message(0), first);
    expect(first.translate).toHaveBeenCalledTimes(251);
    await translateMessage(message(1), second);
    expect(second.translate).toHaveBeenCalledTimes(251);
    expect(getTranslationSchedulerState().cacheEntries).toBe(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires cache entries at five minutes without extending TTL on hits or creating cache timers', async () => {
    const provider = immediateProvider();
    await translateMessage(base, provider);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(1000 + TRANSLATION_LIMITS.cacheTtlMs - 1);
    await translateMessage(base, provider);
    expect(provider.translate).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1000 + TRANSLATION_LIMITS.cacheTtlMs);
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
    await translateMessage(base, provider);
    expect(provider.translate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates whole batches and bounded metadata before dispatch without truncation', async () => {
    const provider = immediateProvider();
    await expect(translateMessages(Array.from({ length: 101 }, (_, index) => message(index)), provider)).rejects.toThrow(TypeError);
    await expect(translateMessages([base, { ...base, text: '' }], provider)).rejects.toThrow(TypeError);
    await expect(translateMessage({ ...base, channelEmotes: Array.from({ length: 501 }, () => 'emote') }, provider)).rejects.toThrow(TypeError);
    await expect(translateMessage({ ...base, channelEmotes: Array.from({ length: 9 }, () => 'x'.repeat(2000)) }, provider)).rejects.toThrow(TypeError);
    expect(provider.translate).not.toHaveBeenCalled();
    expect(await translateMessages([], provider)).toEqual([]);
    const emotes = Array.from({ length: 8 }, () => 'x'.repeat(2000));
    expect(await translateMessage({ ...base, channelEmotes: emotes }, provider)).toMatchObject({ status: 'completed' });
    expect(provider.translate.mock.calls[0]?.[0].channelEmotes).toEqual(emotes);
    expect(await translateMessage({ ...base, channelEmotes: Array.from({ length: 500 }, () => 'e') }, provider))
      .toMatchObject({ status: 'completed' });
  });

  it('keeps reentrant abort-listener submissions queued until physical capacity is released', async () => {
    const fixture = controlledProvider();
    const cancel = controller();
    const first = translateMessage(message(0), fixture.provider, { signal: cancel.signal });
    const others = [1, 2, 3, 4].map(index => translateMessage(message(index), fixture.provider));
    let replacement: ReturnType<typeof translateMessage> | undefined;
    callAt(fixture.calls, 0).signal?.addEventListener('abort', () => {
      replacement = translateMessage(message(5), fixture.provider);
    });
    cancel.abort();
    expect(await first).toBeNull();
    expect(replacement).toBeDefined();
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 1 });
    expect(fixture.calls).toHaveLength(5);
    await settleAll();
    expect(await replacement).toMatchObject({ status: 'completed', messageId: 'message-5' });
    await Promise.all(others);
    expect(peakPhysicalOperations).toBe(5);
  });

  it('does not let cancelled deadlines affect a subsequent operation', async () => {
    const fixture = controlledProvider();
    const cancel = controller();
    const first = translateMessage(message(0), fixture.provider, { signal: cancel.signal });
    await vi.advanceTimersByTimeAsync(1000);
    cancel.abort();
    expect(await first).toBeNull();
    callAt(fixture.calls, 0).resolve();
    await flushMicrotasks();
    const next = translateMessage(message(1), fixture.provider);
    await vi.advanceTimersByTimeAsync(9000);
    expect(callAt(fixture.calls, 1).signal?.aborted).toBe(false);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 1, detachedOperations: 0 });
    await settleAll();
    expect(await next).toMatchObject({ status: 'completed' });
  });

  it('suppresses a running provider completion when cancellation wins the same turn', async () => {
    const fixture = controlledProvider();
    const cancel = controller();
    const pending = translateMessage(base, fixture.provider, { signal: cancel.signal });
    callAt(fixture.calls, 0).resolve();
    cancel.abort();
    expect(await pending).toBeNull();
    await flushMicrotasks();
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, cacheEntries: 0, retainedJobs: 0 });
  });

  it('does not cache late provider rejection or completion after session invalidation', async () => {
    const fixture = controlledProvider();
    const session = activateTranslationSession(base.channelId, 'session');
    const pending = [0, 1].map(index => translateMessage(message(index), fixture.provider, { session }));
    invalidateTranslationSession(base.channelId, session.sessionId);
    expect((await Promise.all(pending)).every(result => result === null)).toBe(true);
    callAt(fixture.calls, 0).reject();
    callAt(fixture.calls, 1).resolve();
    await flushMicrotasks();
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, cacheEntries: 0 });
    expect(getTranslationMetrics()).toMatchObject({ successCount: 0, errorCount: 0 });
  });

  it('rejects a mismatched scoped batch before starting any element', async () => {
    const provider = immediateProvider();
    const session = activateTranslationSession(base.channelId, 'session');
    await expect(translateMessages([base, { ...base, channelId: 'other-channel' }], provider, { session }))
      .rejects.toThrow(TypeError);
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it('rejects invalid lifecycle identifiers and cannot activate sessions while disposed', () => {
    expect(() => activateTranslationSession('', 'session')).toThrow(TypeError);
    expect(() => invalidateTranslationMessage(base.channelId, '')).toThrow(TypeError);
    expect(() => invalidateTranslationUser('', base.userId)).toThrow(TypeError);
    expect(() => invalidateTranslationChannel('')).toThrow(TypeError);
    expect(() => invalidateTranslationSession(base.channelId, '')).toThrow(TypeError);
    disposeTranslationService();
    expect(() => activateTranslationSession(base.channelId, 'session')).toThrow();
  });

  it('releases a cooperative mock operation after the service deadline without leaving latency timers', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 20000, maxLatencyMs: 20000 });
    const pending = translateMessage({ ...base, simulationMode: true }, provider);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, detachedOperations: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves canonical public output and keeps execution context out of provider content and wire events', async () => {
    const fixture = controlledProvider();
    const session = activateTranslationSession(base.channelId, 'session');
    const cancel = controller();
    const fragments: ChatFragment[] = [{ type: 'text', text: base.text }];
    const pending = translateMessage({ ...base, fragments }, fixture.provider, { session, signal: cancel.signal });
    const call = callAt(fixture.calls, 0);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.request).not.toHaveProperty('signal');
    expect(call.request).not.toHaveProperty('session');
    expect(call.request).not.toHaveProperty('channelId');
    await settleAll();
    const bubble = await pending;
    expect(bubble).toMatchObject({
      status: 'completed', messageId: base.messageId, userId: base.userId,
      receivedAtMs: 1234, original: base.text, fragments,
    });
    expect(translationBubbleSchema.safeParse(bubble).success).toBe(true);
    expect(serverEventSchema.safeParse({
      version: 1, type: 'translate:bubble', eventId: '00000000-0000-4000-8000-000000000001',
      channelId: base.channelId, sequence: 1, occurredAtMs: 2000, payload: bubble,
    }).success).toBe(true);
    for (const key of ['session', 'signal', 'provenance', 'provider', 'cacheGeneration']) {
      expect(bubble).not.toHaveProperty(key);
    }
  });

  it.each(['message', 'user', 'channel'] as const)(
    'retains completed batch items through %s moderation until batch delivery', async kind => {
      const fixture = controlledProvider();
      const first = message(0);
      const second = message(1, { channelId: 'unaffected-channel', userId: 'unaffected-user' });
      const batch = translateMessages([first, second], fixture.provider);
      callAt(fixture.calls, 0).resolve();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({
        occupiedSlots: 1, retainedJobs: 2, cacheEntries: 0,
      });
      if (kind === 'message') invalidateTranslationMessage(first.channelId, first.messageId);
      if (kind === 'user') invalidateTranslationUser(first.channelId, first.userId);
      if (kind === 'channel') invalidateTranslationChannel(first.channelId);
      // Clearing unrelated state and resuming must not resurrect an invalidated delivery.
      clearTranslationCache();
      resumeTranslationService();
      callAt(fixture.calls, 1).resolve();
      const results = await batch;
      expect(results[0]).toBeNull();
      expect(results[1]).toMatchObject({ status: 'completed', messageId: second.messageId, original: second.text });
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
      const retry = translateMessage({ ...first, messageId: 'fresh-message' }, fixture.provider);
      expect(fixture.calls).toHaveLength(3);
      await settleAll();
      expect(await retry).toMatchObject({ status: 'completed', messageId: 'fresh-message' });
      expect(peakPhysicalOperations).toBeLessThanOrEqual(5);
    }
  );

  it('preserves unaffected users and input ordering after out-of-order batch completion', async () => {
    const fixture = controlledProvider();
    const inputs = [message(0), message(1, { userId: 'unaffected-user' }), message(2, { userId: 'unaffected-user' })];
    const batch = translateMessages(inputs, fixture.provider);
    callAt(fixture.calls, 2).resolve();
    callAt(fixture.calls, 0).resolve();
    await flushMicrotasks();
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 1, retainedJobs: 3 });
    invalidateTranslationUser(base.channelId, base.userId);
    callAt(fixture.calls, 1).resolve();
    const results = await batch;
    expect(results.map(result => result?.messageId ?? null)).toEqual([null, 'message-1', 'message-2']);
    expect(results[1]).toMatchObject({ status: 'completed', original: 'text-1', translated: 'translated: text-1' });
    expect(results[2]).toMatchObject({ status: 'completed', original: 'text-2', translated: 'translated: text-2' });
    expect(getTranslationSchedulerState().retainedJobs).toBe(0);
  });

  it.each(['revoke', 'replace', 'replace-same-id'] as const)(
    'suppresses completed-but-undelivered session results after %s', async action => {
      const fixture = controlledProvider();
      const session = activateTranslationSession(base.channelId, 'original-session');
      const batch = translateMessages([message(0), message(1)], fixture.provider, { session });
      callAt(fixture.calls, 0).resolve();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 1, retainedJobs: 2 });
      if (action === 'revoke') invalidateTranslationSession(base.channelId, session.sessionId);
      else activateTranslationSession(base.channelId, action === 'replace' ? 'replacement-session' : session.sessionId);
      expect(isTranslationSessionActive(session)).toBe(false);
      expect(await batch).toEqual([null, null]);
      expect(getTranslationSchedulerState()).toMatchObject({
        occupiedSlots: 1, detachedOperations: 1, retainedJobs: 1, cacheEntries: 0,
      });
      clearTranslationCache();
      resumeTranslationService();
      expect(await translateMessage(message(2), fixture.provider, { session })).toBeNull();
      callAt(fixture.calls, 1).resolve();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
    }
  );

  it.each(['cancel', 'dispose', 'dispose-resume'] as const)(
    'settles batch delivery after %s without releasing an unresolved provider permit', async action => {
      const fixture = controlledProvider();
      const cancel = controller();
      const batch = translateMessages([message(0), message(1)], fixture.provider, { signal: cancel.signal });
      callAt(fixture.calls, 0).resolve();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 1, retainedJobs: 2, cacheEntries: 0 });
      if (action === 'cancel') cancel.abort();
      else disposeTranslationService();
      if (action === 'dispose-resume') resumeTranslationService();
      expect(await batch).toEqual([null, null]);
      expect(getTranslationSchedulerState()).toMatchObject({
        occupiedSlots: 1, unresolvedProviderOperations: 1, retainedJobs: 1, cacheEntries: 0,
      });
      expect(callAt(fixture.calls, 1).signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      callAt(fixture.calls, 1).reject();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
    }
  );

  it('keeps cache-hit deliveries invalidatable while another batch item is pending', async () => {
    const fixture = controlledProvider();
    const seed = translateMessage(message(0), fixture.provider);
    callAt(fixture.calls, 0).resolve();
    expect(await seed).toMatchObject({ status: 'completed' });
    const first = message(0, { messageId: 'cached-batch-message' });
    const batch = translateMessages([first, message(1, { channelId: 'unaffected-channel' })], fixture.provider);
    await flushMicrotasks();
    expect(fixture.calls).toHaveLength(2);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 2, occupiedSlots: 1 });
    invalidateTranslationMessage(first.channelId, first.messageId);
    callAt(fixture.calls, 1).resolve();
    const results = await batch;
    expect(results[0]).toBeNull();
    expect(results[1]).toMatchObject({ status: 'completed', messageId: 'message-1' });
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, cacheEntries: 0 });
  });

  it('defers batch caching until delivery and preserves generation-safe clearing', async () => {
    const fixture = controlledProvider();
    const batch = translateMessages([message(0), message(1)], fixture.provider);
    callAt(fixture.calls, 0).resolve();
    await flushMicrotasks();
    expect(getTranslationSchedulerState().cacheEntries).toBe(0);
    clearTranslationCache();
    callAt(fixture.calls, 1).resolve();
    expect((await batch).map(result => result?.messageId)).toEqual(['message-0', 'message-1']);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, cacheEntries: 0 });
    const next = translateMessages([message(2), message(3)], fixture.provider);
    callAt(fixture.calls, 3).resolve();
    callAt(fixture.calls, 2).resolve();
    expect((await next).map(result => result?.messageId)).toEqual(['message-2', 'message-3']);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, cacheEntries: 2 });
    await translateMessages([message(2), message(3)], fixture.provider);
    expect(fixture.calls).toHaveLength(4);
    expect(getTranslationSchedulerState().retainedJobs).toBe(0);
  });

  it('rechecks cache-hit results after individual continuations but before batch return', async () => {
    const provider = immediateProvider();
    const inputs = [message(0), message(1)];
    await translateMessages(inputs, provider);
    const batch = translateMessages(inputs, provider);
    // Both cached individual continuations are queued before this callback;
    // Promise.all and the batch delivery continuation still have to complete.
    const invalidation = Promise.resolve().then(() => {
      invalidateTranslationMessage(base.channelId, 'message-0');
    });
    const results = await batch;
    await invalidation;
    expect(results[0]).toBeNull();
    expect(results[1]).toMatchObject({ status: 'completed', messageId: 'message-1' });
    expect(provider.translate).toHaveBeenCalledTimes(2);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, occupiedSlots: 0, cacheEntries: 0 });
  });

  it('releases batch delivery records on timeout while retaining the unresolved physical operation', async () => {
    const fixture = controlledProvider();
    const batch = translateMessages([message(0), message(1)], fixture.provider);
    callAt(fixture.calls, 0).resolve();
    await flushMicrotasks();
    invalidateTranslationMessage(base.channelId, 'message-0');
    await vi.advanceTimersByTimeAsync(10000);
    const results = await batch;
    expect(results[0]).toBeNull();
    expect(results[1]).toMatchObject({ status: 'unavailable', reason: 'timeout', messageId: 'message-1' });
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 1, occupiedSlots: 1, detachedOperations: 1 });
    callAt(fixture.calls, 1).resolve();
    await flushMicrotasks();
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, occupiedSlots: 0, cacheEntries: 0 });
  });

  it('counts completed batch deliveries against the existing global record bound', async () => {
    const fixture = controlledProvider();
    const immediate = immediateProvider();
    const provider: TranslationProvider = {
      ...fixture.provider,
      translate: (request, execution) => request.text === 'text-99'
        ? fixture.provider.translate(request, execution) : immediate.translate(request),
    };
    const batch = translateMessages(Array.from({ length: 100 }, (_, index) => message(index)), provider);
    for (let index = 0; index < 10; index++) await flushMicrotasks();
    expect(immediate.translate).toHaveBeenCalledTimes(99);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 100, occupiedSlots: 1, queuedJobs: 0 });
    const extras = [100, 101, 102, 103, 104].map(index => translateMessage(message(index), fixture.provider));
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 105, occupiedSlots: 5, queuedJobs: 1 });
    expect(await translateMessage(message(105), fixture.provider)).toMatchObject({ status: 'unavailable', reason: 'capacity' });
    disposeTranslationService();
    expect((await batch).every(result => result === null)).toBe(true);
    expect((await Promise.all(extras)).every(result => result === null)).toBe(true);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 5, occupiedSlots: 5, queuedJobs: 0 });
    await settleAll();
    expect(getTranslationSchedulerState().retainedJobs).toBe(0);
    expect(peakPhysicalOperations).toBe(5);
  });

  it('abandons retained batch records safely if job setup fails', async () => {
    const fixture = controlledProvider();
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      throw new Error('Synthetic timer setup failure.');
    });
    const batch = translateMessages([message(0), message(1)], fixture.provider);
    await expect(batch).rejects.toThrow('Synthetic timer setup failure.');
    timer.mockRestore();
    expect(fixture.calls).toHaveLength(0);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, occupiedSlots: 0, queuedJobs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  const immediateInvalidations = [
    'message', 'user', 'channel', 'revoke', 'replace', 'replace-same-id',
    'cancel', 'dispose', 'dispose-resume',
  ] as const;
  type ImmediateInvalidation = typeof immediateInvalidations[number];

  function invalidateImmediate(action: ImmediateInvalidation, input: TranslateMessageOptions, cancel: AbortController): void {
    switch (action) {
      case 'message': invalidateTranslationMessage(input.channelId, input.messageId); break;
      case 'user': invalidateTranslationUser(input.channelId, input.userId); break;
      case 'channel': invalidateTranslationChannel(input.channelId); break;
      case 'revoke': invalidateTranslationSession(input.channelId, 'early-session'); break;
      case 'replace': activateTranslationSession(input.channelId, 'replacement-session'); break;
      case 'replace-same-id': activateTranslationSession(input.channelId, 'early-session'); break;
      case 'cancel': cancel.abort(); break;
      case 'dispose': disposeTranslationService(); break;
      case 'dispose-resume': disposeTranslationService(); resumeTranslationService(); break;
    }
  }

  it.each(immediateInvalidations)(
    'suppresses immediate unsupported-language content after %s while another item is pending', async action => {
      const fixture = controlledProvider();
      const cancel = controller();
      const first = message(0, { sourceLanguage: null });
      const second = message(1, {
        userId: 'unaffected-user', channelId: action === 'channel' ? 'unaffected-channel' : base.channelId,
      });
      const scoped = action === 'revoke' || action === 'replace' || action === 'replace-same-id';
      const session = scoped ? activateTranslationSession(first.channelId, 'early-session') : undefined;
      const execution = { signal: cancel.signal, ...(session ? { session } : {}) };
      const batch = translateMessages([first, second], fixture.provider, execution);
      await flushMicrotasks();
      expect(fixture.calls).toHaveLength(1);
      expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 2, occupiedSlots: 1, cacheEntries: 0 });
      invalidateImmediate(action, first, cancel);
      if (action === 'message' || action === 'user' || action === 'channel') {
        callAt(fixture.calls, 0).resolve();
        const results = await batch;
        expect(results[0]).toBeNull();
        expect(results[1]).toMatchObject({ status: 'completed', messageId: second.messageId });
      } else {
        expect(await batch).toEqual([null, null]);
        expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 1, retainedJobs: 1 });
        callAt(fixture.calls, 0).reject();
      }
      clearTranslationCache();
      resumeTranslationService();
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
      expect(peakPhysicalOperations).toBe(1);
    }
  );

  it('preserves unaffected immediate unavailable results and their canonical ordering', async () => {
    const fixture = controlledProvider();
    const first = message(0, { sourceLanguage: null });
    const last = message(2, { sourceLanguage: null, userId: 'unaffected-user' });
    const batch = translateMessages([first, message(1, { userId: 'unaffected-user' }), last], fixture.provider);
    await flushMicrotasks();
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 3, occupiedSlots: 1 });
    invalidateTranslationUser(first.channelId, first.userId);
    callAt(fixture.calls, 0).resolve();
    const results = await batch;
    expect(results.map(result => result?.messageId ?? null)).toEqual([null, 'message-1', 'message-2']);
    expect(results[2]).toMatchObject({
      status: 'unavailable', reason: 'unsupported_language', translated: null,
      original: last.text, userId: last.userId, receivedAtMs: last.receivedAtMs,
    });
    expect(translationBubbleSchema.safeParse(results[2]).success).toBe(true);
    expect(getTranslationSchedulerState()).toMatchObject({ retainedJobs: 0, occupiedSlots: 0, cacheEntries: 0 });
  });

  it.each(immediateInvalidations)(
    'keeps an immediate queue-capacity result invalidatable through %s', async action => {
      const fixture = controlledProvider();
      const cancel = controller();
      const first = message(0);
      const second = message(1, {
        userId: 'unaffected-user', channelId: action === 'channel' ? 'unaffected-channel' : base.channelId,
      });
      const scoped = action === 'revoke' || action === 'replace' || action === 'replace-same-id';
      const session = scoped ? activateTranslationSession(first.channelId, 'early-session') : undefined;
      const execution = { signal: cancel.signal, ...(session ? { session } : {}) };
      const captured: {
        batch?: ReturnType<typeof translateMessages>;
        queued?: ReturnType<typeof translateMessages>;
        admission?: ReturnType<typeof getTranslationSchedulerState>;
      } = {};
      const provider: TranslationProvider = {
        ...fixture.provider,
        translate: (request, context) => {
          const pending = fixture.provider.translate(request, context);
          // Reentrant admission while drain owns one slot fills the queue before
          // the other four slots dispatch. Delivery capacity remains available.
          captured.queued = translateMessages(Array.from({ length: 100 }, (_, index) =>
            message(index + 10, { channelId: 'queued-channel' })), fixture.provider);
          captured.batch = translateMessages([first, second], fixture.provider, execution);
          captured.admission = getTranslationSchedulerState();
          invalidateImmediate(action, first, cancel);
          return pending;
        },
      };
      const root = translateMessage(message(900, { channelId: 'root-channel' }), provider);
      if (!captured.batch || !captured.queued) throw new Error('Reentrant capacity fixture did not create its batches.');
      expect(captured.admission).toMatchObject({ occupiedSlots: 1, queuedJobs: 100, retainedJobs: 103 });
      const results = await captured.batch;
      expect(results[0]).toBeNull();
      if (action === 'message' || action === 'user' || action === 'channel') {
        expect(results[1]).toMatchObject({
          status: 'unavailable', reason: 'capacity', translated: null, original: second.text, messageId: second.messageId,
        });
        expect(translationBubbleSchema.safeParse(results[1]).success).toBe(true);
      } else {
        expect(results[1]).toBeNull();
      }
      expect(getTranslationSchedulerState().retainedJobs).toBeLessThanOrEqual(105);
      expect(getTranslationSchedulerState().occupiedSlots).toBeLessThanOrEqual(5);
      disposeTranslationService();
      expect(await root).toBeNull();
      expect((await captured.queued).every(result => result === null)).toBe(true);
      await settleAll();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
      expect(peakPhysicalOperations).toBeLessThanOrEqual(5);
    }
  );

  it.each(immediateInvalidations)(
    'keeps saturated outcomes null after %s while an admitted item in the same batch is pending', async action => {
      const fixture = controlledProvider();
      const running = [1000, 1001, 1002, 1003].map(index =>
        translateMessage(message(index, { channelId: 'running-channel' }), fixture.provider));
      const cancel = controller();
      const rejected = message(1);
      const admitted = message(0, {
        userId: 'unaffected-user', channelId: action === 'channel' ? 'unaffected-channel' : base.channelId,
      });
      const scoped = action === 'revoke' || action === 'replace' || action === 'replace-same-id';
      const session = scoped ? activateTranslationSession(rejected.channelId, 'early-session') : undefined;
      const execution = { signal: cancel.signal, ...(session ? { session } : {}) };
      const captured: { queued?: ReturnType<typeof translateMessages> } = {};
      const provider: TranslationProvider = {
        ...fixture.provider,
        translate: (request, context) => {
          const pending = fixture.provider.translate(request, context);
          captured.queued = translateMessages(Array.from({ length: 100 }, (_, index) =>
            message(index + 10, { channelId: 'queued-channel' })), fixture.provider);
          return pending;
        },
      };
      const batch = translateMessages([
        admitted, rejected, message(2, { sourceLanguage: null }),
      ], provider, execution);
      if (!captured.queued) throw new Error('Saturation fixture did not create its queued batch.');
      await flushMicrotasks();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, retainedJobs: 105, queuedJobs: 100 });
      expect(fixture.calls).toHaveLength(5);
      invalidateImmediate(action, rejected, cancel);
      if (action === 'message' || action === 'user' || action === 'channel') {
        callAt(fixture.calls, 4).resolve();
        const results = await batch;
        expect(results[0]).toMatchObject({ status: 'completed', messageId: admitted.messageId });
        expect(results.slice(1)).toEqual([null, null]);
      } else {
        expect(await batch).toEqual([null, null, null]);
      }
      disposeTranslationService();
      resumeTranslationService();
      expect((await Promise.all(running)).every(result => result === null)).toBe(true);
      expect((await captured.queued).every(result => result === null)).toBe(true);
      await settleAll();
      expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
      expect(peakPhysicalOperations).toBe(5);
    }
  );

  it('fails closed for untrackable immediate batch outcomes at the 105-record limit', async () => {
    const fixture = controlledProvider();
    const running = [0, 1, 2, 3, 4].map(index => translateMessage(message(index), fixture.provider));
    const queued = translateMessages(Array.from({ length: 100 }, (_, index) => message(index + 5)), fixture.provider);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 100, retainedJobs: 105 });
    const results = await translateMessages([
      message(200, { sourceLanguage: null }), message(201),
    ], fixture.provider);
    expect(results).toEqual([null, null]);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, queuedJobs: 100, retainedJobs: 105 });
    expect(fixture.calls).toHaveLength(5);
    disposeTranslationService();
    resumeTranslationService();
    expect((await Promise.all(running)).every(result => result === null)).toBe(true);
    expect((await queued).every(result => result === null)).toBe(true);
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 5, retainedJobs: 5, cacheEntries: 0 });
    await settleAll();
    expect(getTranslationSchedulerState()).toMatchObject({ occupiedSlots: 0, retainedJobs: 0, cacheEntries: 0 });
  });

  it('cancels mock latency promptly and removes its timer and abort listener', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 1000, maxLatencyMs: 1000 });
    const cancel = controller();
    const add = vi.spyOn(cancel.signal, 'addEventListener');
    const remove = vi.spyOn(cancel.signal, 'removeEventListener');
    const pending = provider.translate({
      text: 'hello', sourceLanguage: 'en', targetLanguage: 'es', simulationMode: true,
    }, { signal: cancel.signal });
    expect(vi.getTimerCount()).toBe(1);
    cancel.abort();
    expect(await pending).toMatchObject({ success: false, error: { code: 'PROVIDER_ERROR' } });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles pre-aborted mocks and cleans listeners on successful simulation', async () => {
    const provider = new MockTranslationProvider({ minLatencyMs: 10, maxLatencyMs: 10 });
    const early = controller();
    early.abort();
    const request: TranslationRequest = { text: 'hello', sourceLanguage: 'en', targetLanguage: 'es', simulationMode: true };
    expect(await provider.translate(request, { signal: early.signal })).toMatchObject({ success: false });
    expect(vi.getTimerCount()).toBe(0);
    const cancel = controller();
    const remove = vi.spyOn(cancel.signal, 'removeEventListener');
    const pending = provider.translate(request, { signal: cancel.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ success: true, result: { translatedText: 'hola', provenance: 'simulated' } });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await provider.translate({ ...request, simulationMode: false })).toMatchObject({ success: false });
  });

  it.each([
    { minLatencyMs: -1 }, { maxLatencyMs: -1 }, { minLatencyMs: 0.5 },
    { maxLatencyMs: Number.POSITIVE_INFINITY }, { minLatencyMs: 20, maxLatencyMs: 10 },
    { maxLatencyMs: 2_147_483_648 }, { failureRate: -0.1 }, { failureRate: 1.1 }, { failureRate: Number.NaN },
  ])('rejects invalid mock configuration %j', options => {
    expect(() => new MockTranslationProvider(options)).toThrow(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
