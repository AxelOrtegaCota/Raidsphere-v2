import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const identifierSchema = z.string().min(1).max(128);
export const timestampSchema = z.number().int().nonnegative().safe();
export const countSchema = z.number().int().nonnegative().safe();
export const languageCodeSchema = z.enum(['en', 'es', 'pt', 'fr', 'de', 'ja', 'ko']);
export const illustrativeCountrySchema = z.enum(['US', 'MX', 'BR', 'FR', 'DE', 'JP', 'KR']);
export const loginSchema = z.string().min(1).max(25).regex(/^[a-zA-Z0-9_]+$/);

const displayNameSchema = z.string().min(1).max(100);
const avatarUrlSchema = z.string().max(2048).url().startsWith('https://');

export const candidateSchema = z.object({
  streamerId: identifierSchema,
  login: loginSchema,
  displayName: displayNameSchema,
  avatarUrl: avatarUrlSchema.nullable(),
  language: languageCodeSchema,
  illustrativeCountry: illustrativeCountrySchema.nullable(),
  viewers: countSchema,
  gameName: z.string().max(200),
  title: z.string().max(500),
}).strict();

export const streamerSchema = z.object({
  id: identifierSchema,
  login: loginSchema,
  displayName: displayNameSchema,
  avatarUrl: avatarUrlSchema.nullable(),
  language: languageCodeSchema,
  minViewers: countSchema,
  maxViewers: countSchema,
  acceptsOtherLanguages: z.boolean(),
  reputation: countSchema,
}).strict().refine((value) => value.minViewers <= value.maxViewers, {
  message: 'The minimum viewer count must not exceed the maximum.',
  path: ['minViewers'],
});

export const voteCountsSchema = z.partialRecord(languageCodeSchema, countSchema);

export const rouletteStatusSchema = z.enum([
  'voting', 'selecting', 'chosen', 'raid_pending', 'done', 'cancelled', 'failed', 'unknown',
]);

export const publicRouletteStateSchema = z.object({
  sessionId: identifierSchema,
  fromStreamerId: identifierSchema,
  status: rouletteStatusSchema,
  candidates: z.array(candidateSchema).max(100),
  votes: voteCountsSchema,
  createdAtMs: timestampSchema,
  votingEndsAtMs: timestampSchema.nullable(),
  chosenCandidate: candidateSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.candidates.map((candidate) => candidate.streamerId)).size !== value.candidates.length) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'Candidate identities must be unique.' });
  }
  const isBeforeSelection = value.status === 'voting' || value.status === 'selecting';
  if (isBeforeSelection && value.candidates.length === 0) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'Voting and selection require eligible candidates.' });
  }
  if (isBeforeSelection && value.votingEndsAtMs === null) {
    context.addIssue({ code: 'custom', path: ['votingEndsAtMs'], message: 'Voting and selection require a deadline.' });
  }
  if (isBeforeSelection && value.chosenCandidate !== null) {
    context.addIssue({ code: 'custom', path: ['chosenCandidate'], message: 'The candidate must remain unset until selection is complete.' });
  }
  if (value.votingEndsAtMs !== null && value.votingEndsAtMs <= value.createdAtMs) {
    context.addIssue({ code: 'custom', path: ['votingEndsAtMs'], message: 'The deadline must follow creation.' });
  }
  if (['chosen', 'raid_pending', 'done', 'unknown'].includes(value.status) && value.chosenCandidate === null) {
    context.addIssue({ code: 'custom', path: ['chosenCandidate'], message: 'This state requires a selected candidate.' });
  }
  const eligibleLanguages = new Set<string>(value.candidates.map((candidate) => candidate.language));
  for (const language of Object.keys(value.votes)) {
    if (!eligibleLanguages.has(language)) {
      context.addIssue({ code: 'custom', path: ['votes', language], message: 'Votes must refer to an eligible candidate language.' });
    }
  }
  if (value.chosenCandidate) {
    const selected = value.chosenCandidate;
    const original = value.candidates.find((candidate) => candidate.streamerId === selected.streamerId);
    if (!original || original.language !== selected.language) {
      context.addIssue({ code: 'custom', path: ['chosenCandidate'], message: 'The selected identity and language must match the session pool.' });
    }
  }
});

export const translationWindowSchema = z.object({
  channelId: identifierSchema,
  status: z.enum(['active', 'expired']),
  targetLanguage: languageCodeSchema,
  activatedAtMs: timestampSchema,
  expiresAtMs: timestampSchema,
}).strict().refine((value) => value.expiresAtMs > value.activatedAtMs, {
  message: 'Expiration must follow activation.', path: ['expiresAtMs'],
});

export const chatFragmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(2000) }).strict(),
  z.object({ type: z.literal('emote'), text: z.string().max(2000), emoteId: identifierSchema }).strict(),
  z.object({ type: z.literal('mention'), text: z.string().max(2000), userId: identifierSchema }).strict(),
  z.object({ type: z.literal('link'), text: z.string().max(2000) }).strict(),
]);

const bubbleFields = {
  messageId: identifierSchema,
  userId: identifierSchema,
  displayName: displayNameSchema,
  original: z.string().min(1).max(2000),
  fragments: z.array(chatFragmentSchema).min(1).max(100),
  fromLanguage: languageCodeSchema.nullable(),
  toLanguage: languageCodeSchema,
  illustrativeCountry: illustrativeCountrySchema.nullable(),
  receivedAtMs: timestampSchema,
};

export const translationBubbleSchema = z.discriminatedUnion('status', [
  z.object({ ...bubbleFields, status: z.literal('pending'), translated: z.null() }).strict(),
  z.object({
    ...bubbleFields, status: z.literal('completed'),
    fromLanguage: languageCodeSchema, translated: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    ...bubbleFields, status: z.literal('unavailable'), translated: z.null(),
    reason: z.enum(['timeout', 'capacity', 'provider_error', 'unsupported_language']),
  }).strict(),
]).superRefine((value, context) => {
  if (value.fragments.map((fragment) => fragment.text).join('') !== value.original) {
    context.addIssue({ code: 'custom', path: ['fragments'], message: 'Fragments must reconstruct the original message.' });
  }
});

export const raidLogSchema = z.object({
  sessionId: identifierSchema,
  fromStreamerId: identifierSchema,
  toStreamerId: identifierSchema,
  viewers: countSchema,
  arrivedAtMs: timestampSchema,
}).strict();
