export interface TwitchLanguage {
  readonly code: string;
  readonly name: string;
  /** Representative language marker only; never a verified location. */
  readonly flag: string;
}

/**
 * Broadcast languages accepted by Twitch Helix, plus `other`.
 * Flags are representative language markers, not streamer locations.
 */
export const TWITCH_LANGUAGES: readonly TwitchLanguage[] = Object.freeze([
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
  { code: 'ca', name: 'Catalan', flag: '🇦🇩' },
  { code: 'cs', name: 'Czech', flag: '🇨🇿' },
  { code: 'da', name: 'Danish', flag: '🇩🇰' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'el', name: 'Greek', flag: '🇬🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
  { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
  { code: 'th', name: 'Thai', flag: '🇹🇭' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'other', name: 'Other', flag: '🌐' },
]);

const LANGUAGE_BY_CODE = new Map(
  TWITCH_LANGUAGES.map(language => [language.code, language] as const),
);

export function getLanguageMeta(code: string): TwitchLanguage {
  const normalizedCode = code.trim().toLowerCase() || 'other';
  return LANGUAGE_BY_CODE.get(normalizedCode) ?? {
    code: normalizedCode,
    name: normalizedCode.toUpperCase(),
    flag: '🌐',
  };
}
