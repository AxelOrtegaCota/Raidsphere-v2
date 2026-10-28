/**
 * Module B: Synthetic candidate source
 * 
 * Generates fake streamer candidates for local development and testing.
 * In Phase 3, this is replaced by real Twitch Helix API calls.
 */

import type { Candidate, LanguageCode, IllustrativeCountry } from '@raidsphere/shared';

// Synthetic streamers for development
const SYNTHETIC_STREAMERS: Array<{
  streamerId: string;
  login: string;
  displayName: string;
  language: LanguageCode;
  country: IllustrativeCountry | null;
  games: string[];
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

/**
 * Get synthetic candidates for roulette.
 * Simulates the Helix /streams endpoint with random viewer fluctuation.
 */
export function getSyntheticCandidates(filters: CandidateFilters = {}): Candidate[] {
  const {
    languages,
    minViewers = 5,
    maxViewers = 100,
    excludeStreamerId,
    limit = 20,
  } = filters;
  
  let candidates = SYNTHETIC_STREAMERS
    .filter(s => {
      // Exclude self
      if (excludeStreamerId && s.streamerId === excludeStreamerId) return false;
      
      // Filter by language
      if (languages && languages.length > 0 && !languages.includes(s.language)) return false;
      
      return true;
    })
    .map(s => {
      // Add random viewer fluctuation ±30%
      const fluctuation = 0.7 + Math.random() * 0.6;
      const viewers = Math.round(s.baseViewers * fluctuation);
      const gameIndex = Math.floor(Math.random() * s.games.length);
      const gameName = s.games[gameIndex] ?? s.games[0] ?? 'Just Chatting';
      
      return {
        streamerId: s.streamerId,
        login: s.login,
        displayName: s.displayName,
        avatarUrl: `https://static-cdn.jtvnw.tv/jtv_user_pictures/${s.login}-profile_image-70x70.png`,
        title: `${s.displayName}'s Stream`,
        gameName,
        viewers,
        language: s.language,
        illustrativeCountry: s.country,
      } satisfies Candidate;
    })
    .filter(c => {
      // Filter by viewer range
      return c.viewers >= minViewers && c.viewers <= maxViewers;
    });
  
  // Shuffle and limit
  candidates = shuffleArray(candidates).slice(0, limit);
  
  return candidates;
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
  if (candidates.length === 0) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[index] ?? null;
}

// Fisher-Yates shuffle
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j]!;
    result[j] = temp!;
  }
  return result;
}
