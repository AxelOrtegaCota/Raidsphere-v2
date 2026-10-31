/**
 * Module B: Chat command parser
 *
 * Parses !roulette, !vote <language>, and !cancel commands from chat messages.
 * Normalizes and validates commands before passing to the roulette state machine.
 */

import { z } from 'zod';
import { identifierSchema, languageCodeSchema, loginSchema, timestampSchema } from '@raidsphere/shared';
import type { LanguageCode } from '@raidsphere/shared';

// Supported language codes for voting
const LANGUAGE_CODES = languageCodeSchema.options;

// Language aliases for user-friendly voting
const LANGUAGE_ALIASES: Record<string, LanguageCode> = {
  // English
  'english': 'en', 'eng': 'en', 'en': 'en', 'inglés': 'en', 'ingles': 'en',
  // Spanish
  'spanish': 'es', 'esp': 'es', 'es': 'es', 'español': 'es', 'espanol': 'es',
  // Portuguese
  'portuguese': 'pt', 'port': 'pt', 'pt': 'pt', 'portugués': 'pt', 'portugues': 'pt', 'português': 'pt', 'br': 'pt',
  // French
  'french': 'fr', 'fra': 'fr', 'fr': 'fr', 'français': 'fr', 'francais': 'fr',
  // German
  'german': 'de', 'ger': 'de', 'de': 'de', 'deutsch': 'de', 'alemán': 'de', 'aleman': 'de',
  // Japanese
  'japanese': 'ja', 'jpn': 'ja', 'ja': 'ja', 'jp': 'ja', 'japonés': 'ja', 'japones': 'ja',
  // Korean
  'korean': 'ko', 'kor': 'ko', 'ko': 'ko', 'kr': 'ko', 'coreano': 'ko',
};

// Command types
export type CommandType = 'roulette' | 'vote' | 'cancel';

export interface RouletteCommand {
  type: 'roulette';
  userId: string;
  userLogin: string;
  channelId: string;
}

export interface VoteCommand {
  type: 'vote';
  userId: string;
  userLogin: string;
  channelId: string;
  language: LanguageCode;
}

export interface CancelCommand {
  type: 'cancel';
  userId: string;
  userLogin: string;
  channelId: string;
}

export type ParsedCommand = RouletteCommand | VoteCommand | CancelCommand;

export interface ParseError {
  type: 'error';
  code: 'INVALID_COMMAND' | 'INVALID_LANGUAGE' | 'MISSING_ARGUMENT';
  message: string;
  originalText: string;
}

export type ParseResult = ParsedCommand | ParseError | null;

// Schema for incoming chat message (normalized from Twitch EventSub)
export const chatMessageSchema = z.object({
  messageId: identifierSchema,
  userId: identifierSchema.max(64),
  userLogin: loginSchema,
  channelId: identifierSchema.max(64),
  text: z.string().min(1).max(500),
  timestamp: timestampSchema,
  badges: z.array(z.string()).optional(),
  isBroadcaster: z.boolean().optional(),
  isModerator: z.boolean().optional(),
}).strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Parse a chat message for RaidSphere commands.
 *
 * @param message - Normalized chat message
 * @returns ParsedCommand if valid command, ParseError if invalid, null if not a command
 */
export function parseCommand(message: ChatMessage): ParseResult {
  const parsed = chatMessageSchema.safeParse(message);
  if (!parsed.success) {
    return { type: 'error', code: 'INVALID_COMMAND', message: 'Invalid chat message.', originalText: '' };
  }
  const validatedMessage = parsed.data;
  const text = validatedMessage.text.trim();

  // Must start with ! to be a command
  if (!text.startsWith('!')) {
    return null;
  }

  const parts = text.slice(1).toLowerCase().split(/\s+/);
  const command = parts[0];

  if (!command) {
    return null;
  }

  const baseContext = {
    userId: validatedMessage.userId,
    userLogin: validatedMessage.userLogin,
    channelId: validatedMessage.channelId,
  };

  switch (command) {
    case 'roulette':
    case 'raidsphere':
    case 'spin':
    case 'ruleta':
      return { type: 'roulette', ...baseContext };

    case 'vote':
    case 'votar':
    case 'v': {
      const languageArg = parts[1];

      if (!languageArg) {
        return {
          type: 'error',
          code: 'MISSING_ARGUMENT',
          message: 'Usage: !vote <language> (e.g., !vote spanish, !vote es)',
          originalText: text,
        };
      }

      const normalizedLang = normalizeLanguage(languageArg);

      if (!normalizedLang) {
        return {
          type: 'error',
          code: 'INVALID_LANGUAGE',
          message: `Unknown language: "${languageArg}". Valid: ${LANGUAGE_CODES.join(', ')}`,
          originalText: text,
        };
      }

      return { type: 'vote', language: normalizedLang, ...baseContext };
    }

    case 'cancel':
    case 'cancelar':
    case 'stop':
      return { type: 'cancel', ...baseContext };

    default:
      // Not a RaidSphere command
      return null;
  }
}

/**
 * Normalize a language input to a standard LanguageCode.
 * Accepts full names, abbreviations, and aliases in multiple languages.
 */
export function normalizeLanguage(input: string): LanguageCode | null {
  if (typeof input !== 'string') return null;
  const normalized = input.toLowerCase().trim();
  if (!Object.hasOwn(LANGUAGE_ALIASES, normalized)) return null;
  const parsed = languageCodeSchema.safeParse(LANGUAGE_ALIASES[normalized]);
  return parsed.success ? parsed.data : null;
}

/**
 * Get display name for a language code.
 */
export function getLanguageDisplayName(code: LanguageCode): string {
  const names: Record<LanguageCode, string> = {
    en: 'English',
    es: 'Spanish',
    pt: 'Portuguese',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
  };
  return names[code];
}

/**
 * Get flag emoji for a language code.
 */
export function getLanguageFlag(code: LanguageCode): string {
  const flags: Record<LanguageCode, string> = {
    en: '🇺🇸',
    es: '🇪🇸',
    pt: '🇧🇷',
    fr: '🇫🇷',
    de: '🇩🇪',
    ja: '🇯🇵',
    ko: '🇰🇷',
  };
  return flags[code];
}

/**
 * Check if a user has permission to start/cancel roulette.
 * Phase 2: Only broadcaster and moderators can control roulette.
 */
export function hasControlPermission(message: ChatMessage): boolean {
  return message.isBroadcaster === true || message.isModerator === true;
}

/**
 * Check if a user can vote.
 * Phase 2: Any user in chat can vote.
 */
export function hasVotePermission(_message: ChatMessage): boolean {
  return true;
}
