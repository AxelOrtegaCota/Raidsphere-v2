/**
 * Tests for Module C: Translation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { translationBubbleSchema, serverEventSchema } from '@raidsphere/shared';
import type { ChatFragment } from '@raidsphere/shared';
import { translationRequestSchema, translationResponseSchema } from '../translation/provider.js';
import type { TranslationProvider, TranslationRequest, TranslationResponse } from '../translation/provider.js';
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
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
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
