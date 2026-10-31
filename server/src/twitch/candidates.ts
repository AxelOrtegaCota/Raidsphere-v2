/**
 * Module B: Synthetic candidate source
 *
 * Generates fake streamer candidates for local development and testing.
 * In Phase 3, this is replaced by real Twitch Helix API calls.
 */

import { z } from 'zod';
import { candidateSchema, countSchema, identifierSchema, languageCodeSchema } from '@raidsphere/shared';
import type { Candidate, LanguageCode, IllustrativeCountry } from '@raidsphere/shared';

// Synthetic streamers for development
const SYNTHETIC_STREAMERS: Array<{
  streamerId: string;
  login: string;
  displayName: string;
  language: LanguageCode;
  country: IllustrativeCountry | null;
  games: [string, ...string[]];
  baseViewers: number;
}> = [
  // English streamers (US is the only English IllustrativeCountry)
  { streamerId: 'synth_001', login: 'pixelwarrior', displayName: 'PixelWarrior', language: 'en', country: 'US', games: ['Just Chatting', 'Minecraft'], baseViewers: 25 },
  { streamerId: 'synth_002', login: 'cosmicgamer', displayName: 'CosmicGamer', language: 'en', country: 'US', games: ['Fortnite', 'Apex Legends'], baseViewers: 42 },
  { streamerId: 'synth_003', login: 'retroquest', displayName: 'RetroQuest', language: 'en', country: 'US', games: ['Retro', 'Indie Games'], baseViewers: 18 },

  // Spanish streamers (MX is the only Spanish IllustrativeCountry)
  { streamerId: 'synth_004', login: 'elguerrero', displayName: 'ElGuerrero', language: 'es', country: 'MX', games: ['FIFA', 'League of Legends'], baseViewers: 38 },
  { streamerId: 'synth_005', login: 'laestrellamx', displayName: 'LaEstrellaMX', language: 'es', country: 'MX', games: ['GTA V', 'Valorant'], baseViewers: 55 },
  { streamerId: 'synth_006', login: 'elcazador', displayName: 'ElCazadorAR', language: 'es', country: 'MX', games: ['CS2', 'Dota 2'], baseViewers: 22 },

  // Portuguese streamers (BR is the only Portuguese IllustrativeCountry)
  { streamerId: 'synth_007', login: 'guerreirobr', displayName: 'GuerreiroBR', language: 'pt', country: 'BR', games: ['Free Fire', 'PUBG'], baseViewers: 67 },
  { streamerId: 'synth_008', login: 'estrelapt', displayName: 'EstrelaPT', language: 'pt', country: 'BR', games: ['Valorant', 'Just Chatting'], baseViewers: 15 },

  // French streamers
  { streamerId: 'synth_009', login: 'lechampion', displayName: 'LeChampion', language: 'fr', country: 'FR', games: ['League of Legends', 'TFT'], baseViewers: 48 },
  { streamerId: 'synth_010', login: 'larose', displayName: 'LaRoseFR', language: 'fr', country: 'FR', games: ['Just Chatting', 'Art'], baseViewers: 31 },

  // German streamers
  { streamerId: 'synth_011', login: 'dermeister', displayName: 'DerMeister', language: 'de', country: 'DE', games: ['Minecraft', 'Farming Simulator'], baseViewers: 29 },
  { streamerId: 'synth_012', login: 'blitzgamer', displayName: 'BlitzGamerDE', language: 'de', country: 'DE', games: ['Call of Duty', 'Battlefield'], baseViewers: 44 },

  // Japanese streamers
  { streamerId: 'synth_013', login: 'sakuragamer', displayName: 'SakuraGamer', language: 'ja', country: 'JP', games: ['Final Fantasy', 'Genshin Impact'], baseViewers: 52 },
  { streamerId: 'synth_014', login: 'ninjacat', displayName: 'NinjaCat', language: 'ja', country: 'JP', games: ['Apex Legends', 'Splatoon'], baseViewers: 37 },

  // Korean streamers
  { streamerId: 'synth_015', login: 'starkr', displayName: 'StarKR', language: 'ko', country: 'KR', games: ['StarCraft II', 'League of Legends'], baseViewers: 61 },
  { streamerId: 'synth_016', login: 'flashkr', displayName: 'FlashKR', language: 'ko', country: 'KR', games: ['Overwatch 2', 'Valorant'], baseViewers: 43 },
];

export interface CandidateFilters {
  languages?: LanguageCode[];
  minViewers?: number;
  maxViewers?: number;
  excludeStreamerId?: string;
  limit?: number;
}

const candidateFiltersSchema = z.object({
  languages: z.array(languageCodeSchema).max(languageCodeSchema.options.length).optional(),
  minViewers: countSchema.default(5),
  maxViewers: countSchema.default(100),
  excludeStreamerId: identifierSchema.optional(),
  limit: countSchema.max(100).default(20),
}).strict().refine(value => value.minViewers <= value.maxViewers, {
  message: 'The minimum viewer count must not exceed the maximum.',
});

/**
 * Generate offline candidates. An empty allowed-language list never widens preferences.
 */
export function getSyntheticCandidates(
  filters: CandidateFilters = {},
  random: () => number = Math.random
): Candidate[] {
  const parsed = candidateFiltersSchema.safeParse(filters);
  if (!parsed.success) throw new TypeError('Invalid synthetic candidate filters.');
  if (typeof random !== 'function') throw new TypeError('Invalid random source.');
  const { languages, minViewers, maxViewers, excludeStreamerId, limit } = parsed.data;
  if (limit === 0 || languages?.length === 0) return [];

  const candidates = SYNTHETIC_STREAMERS
    .filter(streamer => streamer.streamerId !== excludeStreamerId &&
      (languages === undefined || languages.includes(streamer.language)))
    .map(streamer => candidateSchema.parse({
      streamerId: streamer.streamerId,
      login: streamer.login,
      displayName: streamer.displayName,
      avatarUrl: null,
      title: streamer.displayName + "'s Stream",
      gameName: streamer.games[Math.floor(readRandom(random) * streamer.games.length)] ?? streamer.games[0],
      viewers: Math.round(streamer.baseViewers * (0.7 + readRandom(random) * 0.6)),
      language: streamer.language,
      illustrativeCountry: streamer.country,
    }))
    .filter(candidate => candidate.viewers >= minViewers && candidate.viewers <= maxViewers);

  return shuffleArray(candidates, random).slice(0, limit);
}

/**
 * Get unique languages from candidates.
 */
export function getAvailableLanguages(candidates: Candidate[]): LanguageCode[] {
  const languages = new Set(candidates.map(c => c.language));
  return Array.from(languages).sort();
}

/**
 * Filter candidates by language.
 */
export function filterCandidatesByLanguage(candidates: Candidate[], language: LanguageCode): Candidate[] {
  return candidates.filter(c => c.language === language);
}

/**
 * Select a random candidate from a list.
 * Uses injectable random for testability.
 */
export function selectRandomCandidate(
  candidates: Candidate[],
  random: () => number = Math.random
): Candidate | null {
  if (!z.array(candidateSchema).safeParse(candidates).success) throw new TypeError('Invalid candidate pool.');
  if (candidates.length === 0) return null;
  const index = Math.floor(readRandom(random) * candidates.length);
  return candidates[index] ?? null;
}

// Fisher-Yates shuffle
function shuffleArray<T>(array: T[], random: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(readRandom(random) * (i + 1));
    const current = result[i];
    const selected = result[j];
    if (current !== undefined && selected !== undefined) {
      result[i] = selected;
      result[j] = current;
    }
  }
  return result;
}

function readRandom(random: () => number): number {
  if (typeof random !== 'function') throw new TypeError('Invalid random source.');
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Random values must be finite and within [0, 1).');
  }
  return value;
}
