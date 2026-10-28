import type { IllustrativeCountry, LanguageCode, Streamer } from '@raidsphere/shared';
import type { LiveChannel } from '../application/ports.js';

// Synthetic demo channels (D2-12). They are not real Twitch accounts and must never be
// presented as real. No avatar URLs, so nothing is fetched from external services.

export const SYNTHETIC_PREFIX = 'rsdemo_';

const COUNTRY_BY_LANGUAGE: Record<LanguageCode, IllustrativeCountry> = {
  en: 'US', es: 'MX', pt: 'BR', fr: 'FR', de: 'DE', ja: 'JP', ko: 'KR',
};

// [language, number, current viewers, min viewers, max viewers, accepts other languages]
type ChannelSpec = readonly [LanguageCode, number, number, number, number, boolean];

// rsdemo_es_01 is the demo source: its 10–20 range yields a small pool across several
// languages, with boundary values (10, 20) and one exclusion by language preference (de_01).
const CHANNEL_SPECS: readonly ChannelSpec[] = [
  ['en', 1, 12, 5, 50, true], ['en', 2, 45, 20, 100, true], ['en', 3, 80, 40, 150, false],
  ['es', 1, 15, 10, 20, true], ['es', 2, 18, 5, 40, false], ['es', 3, 60, 30, 120, true],
  ['pt', 1, 14, 5, 30, true], ['pt', 2, 35, 10, 60, true], ['pt', 3, 5, 1, 15, true],
  ['fr', 1, 22, 10, 40, true], ['fr', 2, 9, 1, 20, true], ['fr', 3, 70, 30, 100, false],
  ['de', 1, 16, 5, 30, false], ['de', 2, 40, 20, 80, true], ['de', 3, 3, 1, 10, true],
  ['ja', 1, 20, 10, 40, true], ['ja', 2, 55, 25, 90, true], ['ja', 3, 7, 1, 15, false],
  ['ko', 1, 25, 10, 50, true], ['ko', 2, 10, 5, 25, true], ['ko', 3, 90, 50, 200, true],
];

export const syntheticLiveChannels: readonly LiveChannel[] = CHANNEL_SPECS.map(
  ([language, number, viewers, minViewers, maxViewers, acceptsOtherLanguages]) => {
    const suffix = `${language}_${String(number).padStart(2, '0')}`;
    const label = `Demo ${language.toUpperCase()} ${String(number).padStart(2, '0')}`;
    const streamer: Streamer = {
      id: `${SYNTHETIC_PREFIX}${suffix}`, login: `${SYNTHETIC_PREFIX}${suffix}`, displayName: label,
      avatarUrl: null, language, minViewers, maxViewers, acceptsOtherLanguages, reputation: 0,
    };
    return {
      streamer, viewers, gameName: 'Synthetic Category', title: `[Synthetic] ${label}`,
      illustrativeCountry: COUNTRY_BY_LANGUAGE[language],
    };
  },
);

export const syntheticStreamers: readonly Streamer[] = syntheticLiveChannels.map((channel) => channel.streamer);
