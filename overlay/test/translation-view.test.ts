import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, serverEventSchema } from '@raidsphere/shared';
import type { ServerEvent, TranslationBubble, TranslationWindow } from '@raidsphere/shared';
import {
  BUBBLE_LIFETIME_MS, MAX_VISIBLE_BUBBLES, applyTranslationEvent, describeBubble, describeWindow,
  initialTranslationView, pruneTranslationView,
} from '../src/translation-view.js';
import type { TranslationView } from '../src/translation-view.js';

// All identifiers are synthetic fixtures.
const CHANNEL = 'rsdemo_ja_01';
const START = 1_000_000;
const WINDOW_MS = 15 * 60_000;
let sequence = 0;

function event(draft: { type: ServerEvent['type']; payload: unknown; occurredAtMs?: number }): ServerEvent {
  sequence += 1;
  return serverEventSchema.parse({
    version: PROTOCOL_VERSION, eventId: randomUUID(), channelId: CHANNEL,
    occurredAtMs: draft.occurredAtMs ?? START, sequence, type: draft.type, payload: draft.payload,
  });
}

function windowPayload(status: TranslationWindow['status'] = 'active'): TranslationWindow {
  return { channelId: CHANNEL, status, targetLanguage: 'ja', activatedAtMs: START, expiresAtMs: START + WINDOW_MS };
}

function bubble(messageId: string, overrides: Partial<Record<string, unknown>> = {}): TranslationBubble {
  const original = typeof overrides.original === 'string' ? overrides.original : `hello ${messageId}`;
  return {
    messageId, userId: 'fixture_user', displayName: 'Fixture User', original,
    fragments: [{ type: 'text', text: original }], fromLanguage: 'en', toLanguage: 'ja',
    illustrativeCountry: null, receivedAtMs: START, status: 'completed', translated: `translated ${messageId}`,
    ...overrides,
  } as TranslationBubble;
}

const opened = (): TranslationView =>
  applyTranslationEvent(initialTranslationView, event({ type: 'translation:window', payload: windowPayload() }), START);
const show = (view: TranslationView, payload: TranslationBubble, nowMs = START) =>
  applyTranslationEvent(view, event({ type: 'translate:bubble', payload, occurredAtMs: nowMs }), nowMs);
const ids = (view: TranslationView) => view.bubbles.map((entry) => entry.messageId);

describe('translation window display', () => {
  it('shows the active window from a snapshot and its remaining minutes', () => {
    const view = applyTranslationEvent(initialTranslationView, event({
      type: 'state:snapshot', payload: { roulette: null, translationWindow: windowPayload() },
    }), START);
    expect(describeWindow(view, START)).toBe('Automatic chat translation to JA · 15 min left');
    expect(describeWindow(view, START + WINDOW_MS - 61_000)).toBe('Automatic chat translation to JA · 2 min left');
    expect(describeWindow(view, START + WINDOW_MS)).toBeNull();
    expect(describeWindow(initialTranslationView, START)).toBeNull();
  });

  it('shows no bubbles without an active window', () => {
    expect(ids(show(initialTranslationView, bubble('m1')))).toEqual([]);
    expect(ids(show(opened(), bubble('m1'), START + WINDOW_MS))).toEqual([]);
  });

  it('clears bubbles when the window expires by event or by time', () => {
    const view = show(opened(), bubble('m1'));
    expect(ids(view)).toEqual(['m1']);
    const expired = applyTranslationEvent(view, event({ type: 'translation:window', payload: windowPayload('expired') }), START);
    expect(ids(expired)).toEqual([]);
    expect(describeWindow(expired, START)).toBeNull();
    expect(ids(pruneTranslationView(view, START + WINDOW_MS))).toEqual([]);
  });
});

describe('translation bubbles', () => {
  it('updates a pending bubble in place and restarts its lifetime', () => {
    let view = show(opened(), bubble('m1', { status: 'pending', translated: null }));
    view = show(view, bubble('m2'), START + 1_000);
    expect(describeBubble(view.bubbles[0]!)).toEqual({ primary: 'hello m1', secondary: 'Translating…', languages: 'EN → JA' });

    view = show(view, bubble('m1'), START + 4_000);
    expect(ids(view)).toEqual(['m1', 'm2']);
    expect(describeBubble(view.bubbles[0]!)).toEqual({ primary: 'translated m1', secondary: 'hello m1', languages: 'EN → JA' });
    expect(ids(pruneTranslationView(view, START + 1_000 + BUBBLE_LIFETIME_MS))).toEqual(['m1']);
    expect(ids(pruneTranslationView(view, START + 4_000 + BUBBLE_LIFETIME_MS))).toEqual([]);
  });

  it('never presents untranslated text as a translation', () => {
    const view = show(opened(), bubble('m1', {
      status: 'unavailable', translated: null, reason: 'timeout', fromLanguage: null,
    }));
    expect(describeBubble(view.bubbles[0]!)).toEqual({
      primary: 'hello m1', secondary: 'Translation unavailable', languages: '?? → JA',
    });
  });

  it('keeps only the newest bubbles visible', () => {
    let view = opened();
    for (let index = 0; index <= MAX_VISIBLE_BUBBLES; index += 1) view = show(view, bubble(`m${index}`));
    expect(ids(view)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps markup-like chat text as plain text for textContent rendering', () => {
    const text = '<img src=x onerror=alert(1)>';
    const view = show(opened(), bubble('m1', { original: text, translated: text }));
    expect(describeBubble(view.bubbles[0]!)).toMatchObject({ primary: text, secondary: text });
  });
});

describe('moderation in the overlay', () => {
  it('removes a message and ignores its late updates', () => {
    let view = show(opened(), bubble('m1', { status: 'pending', translated: null }));
    view = show(view, bubble('m2'));
    view = applyTranslationEvent(view, event({ type: 'translate:remove', payload: { messageId: 'm1' } }), START);
    expect(ids(view)).toEqual(['m2']);
    expect(ids(show(view, bubble('m1')))).toEqual(['m2']);
  });

  it('clears one user, ignores their earlier messages, and shows later ones', () => {
    let view = show(opened(), bubble('m1'));
    view = show(view, bubble('m2', { userId: 'other_user' }));
    view = applyTranslationEvent(view, event({
      type: 'translate:clear', payload: { scope: 'user', userId: 'fixture_user' }, occurredAtMs: START + 5_000,
    }), START + 5_000);
    expect(ids(view)).toEqual(['m2']);
    expect(ids(show(view, bubble('m3', { receivedAtMs: START + 5_000 })))).toEqual(['m2']);
    expect(ids(show(view, bubble('m4', { receivedAtMs: START + 6_000 }), START + 6_000))).toEqual(['m2', 'm4']);
  });

  it('clears the channel and ignores messages received before the clear', () => {
    let view = show(opened(), bubble('m1'));
    view = applyTranslationEvent(view, event({
      type: 'translate:clear', payload: { scope: 'channel' }, occurredAtMs: START + 5_000,
    }), START + 5_000);
    expect(ids(view)).toEqual([]);
    expect(ids(show(view, bubble('m2', { receivedAtMs: START + 4_000 })))).toEqual([]);
    expect(ids(show(view, bubble('m3', { receivedAtMs: START + 6_000 }), START + 6_000))).toEqual(['m3']);
  });
});
