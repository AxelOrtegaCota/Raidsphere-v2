import type { LanguageCode, ServerEvent, TranslationBubble, TranslationWindow } from '@raidsphere/shared';

// Translation bubble display state (Phase 4, module 6), derived only from validated server
// events. The backend decides what is translated; this mirror only shows and hides bubbles.

export const BUBBLE_LIFETIME_MS = 10_000;
export const MAX_VISIBLE_BUBBLES = 4;
// Bounds the moderation memory that stops late updates from resurrecting removed messages.
const MODERATION_MEMORY = 200;

export interface BubbleView {
  messageId: string;
  userId: string;
  displayName: string;
  status: TranslationBubble['status'];
  original: string;
  translated: string | null;
  fromLanguage: LanguageCode | null;
  toLanguage: LanguageCode;
  // Each update restarts the lifetime, so a translation that completes late is still readable.
  shownAtMs: number;
}

export interface TranslationView {
  window: TranslationWindow | null;
  // Oldest first.
  bubbles: readonly BubbleView[];
  moderation: Moderation;
}

// Server timestamps of moderation actions; messages received up to them are never shown.
interface Moderation {
  removedMessageIds: readonly string[];
  clearedUsers: readonly { userId: string; clearedAtMs: number }[];
  channelClearedAtMs: number | null;
}

export const initialTranslationView: TranslationView = {
  window: null, bubbles: [], moderation: { removedMessageIds: [], clearedUsers: [], channelClearedAtMs: null },
};

export function applyTranslationEvent(view: TranslationView, event: ServerEvent, nowMs: number): TranslationView {
  switch (event.type) {
    case 'state:snapshot':
      return withWindow(view, event.payload.translationWindow, nowMs);
    case 'translation:window':
      return withWindow(view, event.payload, nowMs);
    case 'translate:bubble':
      // Bubbles outside an active window are not shown, even if one arrives late.
      if (!windowActive(view.window, nowMs) || moderated(view.moderation, event.payload)) return view;
      return { ...view, bubbles: upsert(view.bubbles, toBubbleView(event.payload, nowMs)) };
    case 'translate:remove': {
      const { messageId } = event.payload;
      return {
        ...view,
        bubbles: view.bubbles.filter((bubble) => bubble.messageId !== messageId),
        moderation: { ...view.moderation, removedMessageIds: bounded([...view.moderation.removedMessageIds, messageId]) },
      };
    }
    case 'translate:clear': {
      const { payload } = event;
      if (payload.scope === 'channel') {
        return { ...view, bubbles: [], moderation: { ...view.moderation, channelClearedAtMs: event.occurredAtMs } };
      }
      const clearedUsers = bounded([
        ...view.moderation.clearedUsers.filter((entry) => entry.userId !== payload.userId),
        { userId: payload.userId, clearedAtMs: event.occurredAtMs },
      ]);
      return {
        ...view,
        bubbles: view.bubbles.filter((bubble) => bubble.userId !== payload.userId),
        moderation: { ...view.moderation, clearedUsers },
      };
    }
    default:
      return view;
  }
}

// Drops bubbles past their lifetime and everything once the window has expired.
export function pruneTranslationView(view: TranslationView, nowMs: number): TranslationView {
  if (!windowActive(view.window, nowMs)) return view.bubbles.length === 0 ? view : { ...view, bubbles: [] };
  const bubbles = view.bubbles.filter((bubble) => nowMs - bubble.shownAtMs < BUBBLE_LIFETIME_MS);
  return bubbles.length === view.bubbles.length ? view : { ...view, bubbles };
}

export function windowActive(window: TranslationWindow | null, nowMs: number): boolean {
  return window?.status === 'active' && nowMs < window.expiresAtMs;
}

// Text for one bubble. Untranslated text is never presented as a translation.
export function describeBubble(bubble: BubbleView): { primary: string; secondary: string; languages: string } {
  const languages = `${bubble.fromLanguage?.toUpperCase() ?? '??'} → ${bubble.toLanguage.toUpperCase()}`;
  switch (bubble.status) {
    case 'completed':
      return { primary: bubble.translated ?? bubble.original, secondary: bubble.original, languages };
    case 'pending':
      return { primary: bubble.original, secondary: 'Translating…', languages };
    case 'unavailable':
      return { primary: bubble.original, secondary: 'Translation unavailable', languages };
  }
}

export function describeWindow(view: TranslationView, nowMs: number): string | null {
  const { window } = view;
  if (!window || !windowActive(window, nowMs)) return null;
  const minutes = Math.max(1, Math.ceil((window.expiresAtMs - nowMs) / 60_000));
  return `Automatic chat translation to ${window.targetLanguage.toUpperCase()} · ${minutes} min left`;
}

function withWindow(view: TranslationView, window: TranslationWindow | null, nowMs: number): TranslationView {
  return { ...view, window, bubbles: windowActive(window, nowMs) ? view.bubbles : [] };
}

function moderated(moderation: Moderation, bubble: TranslationBubble): boolean {
  if (moderation.removedMessageIds.includes(bubble.messageId)) return true;
  if (moderation.channelClearedAtMs !== null && bubble.receivedAtMs <= moderation.channelClearedAtMs) return true;
  const cleared = moderation.clearedUsers.find((entry) => entry.userId === bubble.userId);
  return cleared !== undefined && bubble.receivedAtMs <= cleared.clearedAtMs;
}

function bounded<T>(values: readonly T[]): readonly T[] {
  return values.slice(-MODERATION_MEMORY);
}

function toBubbleView(bubble: TranslationBubble, nowMs: number): BubbleView {
  return {
    messageId: bubble.messageId, userId: bubble.userId, displayName: bubble.displayName, status: bubble.status,
    original: bubble.original, translated: bubble.translated, fromLanguage: bubble.fromLanguage,
    toLanguage: bubble.toLanguage, shownAtMs: nowMs,
  };
}

// Updates keep their position; new bubbles push out the oldest beyond the visible limit.
function upsert(bubbles: readonly BubbleView[], next: BubbleView): readonly BubbleView[] {
  if (bubbles.some((bubble) => bubble.messageId === next.messageId)) {
    return bubbles.map((bubble) => (bubble.messageId === next.messageId ? next : bubble));
  }
  return [...bubbles, next].slice(-MAX_VISIBLE_BUBBLES);
}
