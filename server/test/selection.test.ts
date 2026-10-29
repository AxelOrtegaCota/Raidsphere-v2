import { describe, expect, it } from 'vitest';
import type { Candidate, LanguageCode } from '@raidsphere/shared';
import { pickCandidate, poolLanguages, winningLanguage } from '../src/application/selection.js';
import { ScriptedRandom } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures.
const candidate = (language: LanguageCode, id: string): Candidate => ({
  streamerId: id, login: id, displayName: 'Demo Candidate', avatarUrl: null, language,
  illustrativeCountry: null, viewers: 10, gameName: 'Synthetic Category', title: '[Synthetic] Demo',
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
