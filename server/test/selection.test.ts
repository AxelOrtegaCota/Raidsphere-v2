import { describe, expect, it } from 'vitest';
import type { Candidate, LanguageCode } from '@raidsphere/shared';
import { autoCandidates, pickCandidate, poolLanguages, winningLanguage } from '../src/application/selection.js';
import { ScriptedRandom } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures.
const candidate = (language: LanguageCode, id: string, viewers = 10): Candidate => ({
  streamerId: id, login: id, displayName: 'Demo Candidate', avatarUrl: null, language,
  illustrativeCountry: null, viewers, gameName: 'Synthetic Category', title: '[Synthetic] Demo',
});

describe('automatic audience-size ladder', () => {
  it.each([6, 7] as const)('covers the lowest %i tiers first when all seven are populated', (count) => {
    const viewers = [0, 11, 51, 101, 251, 501, 1_001];
    const live = viewers.map((value, index) => candidate('en', `rsdemo_${index}`, value)).reverse();
    const chosen = autoCandidates('rsdemo_source', live, count, new ScriptedRandom([]));
    expect(chosen.map((entry) => entry.viewers)).toEqual(viewers.slice(0, count));
  });

  it('uses inclusive lower and upper boundaries and the injected draw within every tier', () => {
    const lower = [0, 11, 51, 101, 251, 501, 1_001];
    const upper = [10, 50, 100, 250, 500, 1_000, 2_000];
    const live = lower.flatMap((value, index) => [
      candidate('en', `rsdemo_low_${index}`, value), candidate('en', `rsdemo_high_${index}`, upper[index]!),
    ]);
    const first = new ScriptedRandom([0, 0, 0, 0, 0, 0, 0]);
    const last = new ScriptedRandom([1, 1, 1, 1, 1, 1, 1]);
    expect(autoCandidates('rsdemo_source', live, 7, first).map((entry) => entry.viewers)).toEqual(lower);
    expect(autoCandidates('rsdemo_source', live, 7, last).map((entry) => entry.viewers)).toEqual(upper);
    expect(first.remaining).toBe(0); expect(last.remaining).toBe(0);
  });

  it.each([6, 7] as const)('fills %i slots from sparse tiers in ascending round-robin order without mutating inputs', (count) => {
    const live = Object.freeze([1, 110, 2, 120, 3, 130, 4, 140].map((viewers, index) =>
      Object.freeze(candidate('en', `rsdemo_${index}`, viewers))));
    const before = live.map((entry) => ({ ...entry }));
    const random = new ScriptedRandom([0, 0, 0, 0, 0, 0]);
    const chosen = autoCandidates('rsdemo_source', live, count, random);
    expect(chosen.map((entry) => entry.viewers)).toEqual(count === 6 ? [1, 2, 3, 110, 120, 130] : [1, 2, 3, 4, 110, 120, 130]);
    expect(new Set(chosen.map((entry) => entry.streamerId)).size).toBe(count);
    expect(random.remaining).toBe(0);
    expect(live).toEqual(before);
  });

  it('returns all available channels, including zero viewers, when fewer than requested exist', () => {
    const live = [candidate('en', 'rsdemo_large', 1_500), candidate('en', 'rsdemo_zero', 0), candidate('en', 'rsdemo_small', 11)];
    expect(autoCandidates('rsdemo_source', live, 7, new ScriptedRandom([]))).toEqual([live[1], live[2], live[0]]);
    expect(autoCandidates('rsdemo_source', [], 6, new ScriptedRandom([]))).toEqual([]);
  });

  it('excludes the source and keeps only the last entry for a duplicate channel, even across tiers', () => {
    const replacement = candidate('en', 'rsdemo_duplicate', 150);
    const unique = candidate('en', 'rsdemo_unique', 0);
    const live = [candidate('en', 'rsdemo_source', 1), candidate('en', 'rsdemo_duplicate', 5), unique, replacement];
    expect(autoCandidates('rsdemo_source', live, 7, new ScriptedRandom([]))).toEqual([unique, replacement]);
  });

  it('continues filling from remaining tiers after a smaller tier is exhausted', () => {
    const live = [candidate('en', 'rsdemo_small', 5), ...[110, 120, 130, 140, 150].map((viewers, index) => candidate('en', `rsdemo_large_${index}`, viewers))];
    const random = new ScriptedRandom([0, 0, 0, 0]);
    expect(autoCandidates('rsdemo_source', live, 7, random)).toEqual(live);
    expect(random.remaining).toBe(0);
  });
});

describe('winning language', () => {
  it('lists distinct pool languages in order of appearance', () => {
    expect(poolLanguages([
      candidate('ja', 'rsdemo_a'), candidate('en', 'rsdemo_b'), candidate('ja', 'rsdemo_c'),
    ])).toEqual(['ja', 'en']);
  });

  it('picks a clear winner without drawing', () => {
    expect(winningLanguage({ en: 3, ja: 1 }, ['en', 'ja', 'pt'], new ScriptedRandom([]))).toBe('en');
  });

  it('draws only among languages tied for the highest count', () => {
    const languages: LanguageCode[] = ['en', 'ja', 'pt'];
    expect(winningLanguage({ en: 2, ja: 1, pt: 2 }, languages, new ScriptedRandom([0]))).toBe('en');
    expect(winningLanguage({ en: 2, ja: 1, pt: 2 }, languages, new ScriptedRandom([1]))).toBe('pt');
    expect(() => winningLanguage({ en: 2, ja: 1, pt: 2 }, languages, new ScriptedRandom([2]))).toThrow();
  });

  it('draws among every pool language when nobody voted', () => {
    expect(winningLanguage({}, ['en', 'ja', 'pt'], new ScriptedRandom([2]))).toBe('pt');
    expect(winningLanguage({ en: 0 }, ['en', 'ja'], new ScriptedRandom([1]))).toBe('ja');
  });
});

describe('candidate pick', () => {
  const pool = [candidate('en', 'rsdemo_en_a'), candidate('ja', 'rsdemo_ja_a'), candidate('en', 'rsdemo_en_b')];

  it('draws only among candidates of the winning language', () => {
    expect(pickCandidate(pool, 'en', new ScriptedRandom([1])).streamerId).toBe('rsdemo_en_b');
    expect(pickCandidate(pool, 'ja', new ScriptedRandom([])).streamerId).toBe('rsdemo_ja_a');
  });

  it('fails when the language has no candidates', () => {
    expect(() => pickCandidate(pool, 'ko', new ScriptedRandom([]))).toThrow();
  });
});
