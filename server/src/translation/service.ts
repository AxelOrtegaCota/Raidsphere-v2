/**
 * Module C: Translation service
 * 
 * High-level translation API with caching, fallbacks, and metrics.
 * Returns payloads compatible with the shared TranslationBubble schema.
 */

import { LanguageCode, TranslationBubble, ChatFragment } from '@raidsphere/shared';
import { fragmentMessage, restoreFragments, extractEmotes } from './emotes.js';
import {
  TranslationProvider,
  TranslationRequest,
  TranslationResponse,
  needsTranslation,
} from './provider.js';
import { getTranslationProvider } from './mock-provider.js';

export interface TranslateMessageOptions {
  messageId: string;
  userId: string;
  displayName: string;
  text: string;
  sourceLanguage: LanguageCode | null;
  targetLanguage: LanguageCode;
  channelEmotes?: string[];
}

export interface TranslationMetrics {
  totalRequests: number;
  cacheHits: number;
  successCount: number;
  errorCount: number;
  averageLatencyMs: number;
}

// Simple in-memory cache (replace with Redis in production)
const translationCache = new Map<string, TranslationBubble>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Metrics
let metrics: TranslationMetrics = {
  totalRequests: 0,
  cacheHits: 0,
  successCount: 0,
  errorCount: 0,
  averageLatencyMs: 0,
};

/**
 * Convert raw text into ChatFragment array for the bubble schema.
 */
function textToFragments(text: string): ChatFragment[] {
  // Simple implementation: single text fragment
  // In production, parse emotes/mentions/links properly
  return [{ type: 'text', text }];
}

/**
 * Translate a chat message and return a TranslationBubble event payload.
 */
export async function translateMessage(
  options: TranslateMessageOptions,
  provider?: TranslationProvider
): Promise<TranslationBubble | null> {
  const {
    messageId,
    userId,
    displayName,
    text,
    sourceLanguage,
    targetLanguage,
    channelEmotes = [],
  } = options;
  
  metrics.totalRequests++;
  
  // Skip if same language
  if (sourceLanguage && !needsTranslation(sourceLanguage, targetLanguage)) {
    return null;
  }
  
  // Check cache
  const cacheKey = getCacheKey(text, sourceLanguage, targetLanguage);
  const cached = translationCache.get(cacheKey);
  if (cached) {
    metrics.cacheHits++;
    // Return cached with updated metadata
    return {
      ...cached,
      messageId,
      userId,
      displayName,
      receivedAtMs: Date.now(),
    };
  }
  
  // Get provider
  const translationProvider = provider ?? getTranslationProvider();
  
  // For translation, we need a source language
  const effectiveSourceLanguage = sourceLanguage ?? 'en'; // Default assumption
  
  // Make request
  const request: TranslationRequest = {
    text,
    sourceLanguage: effectiveSourceLanguage,
    targetLanguage,
    channelEmotes,
  };
  
  const startTime = Date.now();
  const response = await translationProvider.translate(request);
  const latencyMs = Date.now() - startTime;
  
  // Update metrics
  updateAverageLatency(latencyMs);
  
  if (!response.success) {
    metrics.errorCount++;
    console.error(`Translation failed: ${response.error.message}`);
    
    // Return unavailable bubble
    const unavailableBubble: TranslationBubble = {
      status: 'unavailable',
      messageId,
      userId,
      displayName,
      original: text,
      fragments: textToFragments(text),
      fromLanguage: sourceLanguage,
      toLanguage: targetLanguage,
      illustrativeCountry: null,
      receivedAtMs: Date.now(),
      translated: null,
      reason: 'provider_error',
    };
    return unavailableBubble;
  }
  
  metrics.successCount++;
  
  // Build completed bubble payload
  const bubble: TranslationBubble = {
    status: 'completed',
    messageId,
    userId,
    displayName,
    original: text,
    fragments: textToFragments(text),
    fromLanguage: effectiveSourceLanguage,
    toLanguage: targetLanguage,
    illustrativeCountry: null,
    receivedAtMs: Date.now(),
    translated: response.result.translatedText,
  };
  
  // Cache the result
  cacheTranslation(cacheKey, bubble);
  
  return bubble;
}

/**
 * Batch translate multiple messages.
 */
export async function translateMessages(
  messages: TranslateMessageOptions[],
  provider?: TranslationProvider
): Promise<(TranslationBubble | null)[]> {
  // Process in parallel with concurrency limit
  const CONCURRENCY = 5;
  const results: (TranslationBubble | null)[] = [];
  
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const batch = messages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(msg => translateMessage(msg, provider))
    );
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * Get current translation metrics.
 */
export function getTranslationMetrics(): TranslationMetrics {
  return { ...metrics };
}

/**
 * Reset metrics (for testing).
 */
export function resetTranslationMetrics(): void {
  metrics = {
    totalRequests: 0,
    cacheHits: 0,
    successCount: 0,
    errorCount: 0,
    averageLatencyMs: 0,
  };
}

/**
 * Clear translation cache (for testing).
 */
export function clearTranslationCache(): void {
  translationCache.clear();
}

// Helper functions
function getCacheKey(text: string, source: LanguageCode | null, target: LanguageCode): string {
  return `${source ?? 'auto'}:${target}:${text.toLowerCase().trim()}`;
}

function cacheTranslation(key: string, bubble: TranslationBubble): void {
  translationCache.set(key, bubble);
  
  // Auto-expire
  setTimeout(() => {
    translationCache.delete(key);
  }, CACHE_TTL_MS);
}

function updateAverageLatency(latencyMs: number): void {
  const total = metrics.successCount + metrics.errorCount;
  if (total === 0) {
    metrics.averageLatencyMs = latencyMs;
  } else {
    // Running average
    metrics.averageLatencyMs = (metrics.averageLatencyMs * total + latencyMs) / (total + 1);
  }
}
