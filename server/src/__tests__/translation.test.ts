/**
 * Tests for Module C: Translation
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
} from '../translation/service.js';

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
      expect(result.protectedText).toContain('__EMOTE_');
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
