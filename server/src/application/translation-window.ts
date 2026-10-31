import type { LanguageCode, TranslationWindow } from '@raidsphere/shared';

// Pure translation window rules (Phase 4, module 3). A window opens on a confirmed raid
// arrival only, targets the destination channel's language, and lasts a fixed duration.

export const TRANSLATION_WINDOW_MS = 15 * 60_000;

export function openWindow(
  channelId: string, targetLanguage: LanguageCode, nowMs: number, durationMs: number,
): TranslationWindow {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error('A translation window must last a positive whole number of milliseconds.');
  }
  return { channelId, status: 'active', targetLanguage, activatedAtMs: nowMs, expiresAtMs: nowMs + durationMs };
}

export function expireWindow(window: TranslationWindow): TranslationWindow {
  return { ...window, status: 'expired' };
}

// A stored window past its deadline is reported as expired even before its timer runs.
export function effectiveWindow(window: TranslationWindow | null, nowMs: number): TranslationWindow | null {
  if (!window || window.status === 'expired' || nowMs < window.expiresAtMs) return window;
  return expireWindow(window);
}

export function isWindowActive(window: TranslationWindow | null, nowMs: number): boolean {
  return effectiveWindow(window, nowMs)?.status === 'active';
}
