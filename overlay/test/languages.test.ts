import { describe, expect, it } from 'vitest';
import { TWITCH_LANGUAGES, getLanguageMeta } from '../src/languages.js';

const EXPECTED_TWITCH_LANGUAGE_CODES = [
  'ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hu',
  'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'th',
  'tr', 'vi', 'zh', 'other',
];

describe('Twitch stream languages', () => {
  it('offers every Twitch-supported broadcast language plus Other', () => {
    expect(TWITCH_LANGUAGES.map(language => language.code).sort()).toEqual(
      [...EXPECTED_TWITCH_LANGUAGE_CODES].sort(),
    );
  });

  it('gives every language a visible representative flag and label', () => {
    for (const language of TWITCH_LANGUAGES) {
      expect(language.name.length).toBeGreaterThan(0);
      expect(language.flag.length).toBeGreaterThan(0);
    }
  });

  it('falls back safely for an unexpected Helix language code', () => {
    expect(getLanguageMeta('xx')).toEqual({
      code: 'xx',
      name: 'XX',
      flag: '🌐',
    });
  });
});
