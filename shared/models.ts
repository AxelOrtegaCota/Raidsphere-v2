import type { z } from 'zod';
import type {
  candidateSchema, chatFragmentSchema, countryCodeSchema, countryFlagStateSchema,
  flagContributionSchema, illustrativeCountrySchema, languageCodeSchema,
  publicRouletteStateSchema, raidLogSchema, rouletteConfigSchema, rouletteModeSchema,
  rouletteStatusSchema, streamerSchema, translationBubbleSchema, translationWindowSchema,
  voteCountsSchema,
} from './schemas.js';

// Public models are inferred from runtime schemas and never contain credentials.
export type Candidate = z.infer<typeof candidateSchema>;
export type Streamer = z.infer<typeof streamerSchema>;
export type LanguageCode = z.infer<typeof languageCodeSchema>;
export type IllustrativeCountry = z.infer<typeof illustrativeCountrySchema>;
export type VoteCounts = z.infer<typeof voteCountsSchema>;
export type RouletteStatus = z.infer<typeof rouletteStatusSchema>;
export type PublicRouletteState = z.infer<typeof publicRouletteStateSchema>;
export type TranslationWindow = z.infer<typeof translationWindowSchema>;
export type ChatFragment = z.infer<typeof chatFragmentSchema>;
export type TranslationBubble = z.infer<typeof translationBubbleSchema>;
export type RaidLog = z.infer<typeof raidLogSchema>;

// Roulette mode and flag competition types
export type CountryCode = z.infer<typeof countryCodeSchema>;
export type RouletteMode = z.infer<typeof rouletteModeSchema>;
export type CountryFlagState = z.infer<typeof countryFlagStateSchema>;
export type FlagContribution = z.infer<typeof flagContributionSchema>;
export type RouletteConfig = z.infer<typeof rouletteConfigSchema>;
