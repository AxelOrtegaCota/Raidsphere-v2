import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const identifierSchema = z.string().min(1).max(128);
export const timestampSchema = z.number().int().nonnegative().safe();
export const countSchema = z.number().int().nonnegative().safe();
export const languageCodeSchema = z.enum(['en', 'es', 'pt', 'fr', 'de', 'ja', 'ko']);
// Stream metadata is broader than the languages supported by voting and translation.
export const streamLanguageSchema = z.string().min(1).max(35).regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/);
export const illustrativeCountrySchema = z.enum(['US', 'MX', 'BR', 'FR', 'DE', 'JP', 'KR']);
export const loginSchema = z.string().min(1).max(25).regex(/^[a-zA-Z0-9_]+$/);

const displayNameSchema = z.string().min(1).max(100);
const avatarUrlSchema = z.string().max(2048).url().startsWith('https://');

export const candidateSchema = z.object({
  streamerId: identifierSchema,
  login: loginSchema,
  displayName: displayNameSchema,
  avatarUrl: avatarUrlSchema.nullable(),
  language: streamLanguageSchema,
  illustrativeCountry: illustrativeCountrySchema.nullable(),
  viewers: countSchema,
  gameName: z.string().max(200),
  title: z.string().max(500),
}).strict();

export const discoveryCandidateSchema = z.object({
  id: z.string().min(1).max(25).regex(/^[0-9]+$/), login: loginSchema, displayName: displayNameSchema,
  game: z.string().max(200), title: z.string().max(500), viewers: countSchema,
  language: z.union([streamLanguageSchema, z.literal('')]),
  thumbnailUrl: z.union([avatarUrlSchema, z.literal('')]).default(''),
  profileImageUrl: z.union([avatarUrlSchema, z.literal('')]).default(''), isLive: z.boolean(),
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export const discoveryResponseSchema = z.object({
  streams: z.array(discoveryCandidateSchema).max(100), search_results: z.array(discoveryCandidateSchema).max(100),
});

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
  // Absent in older chat sessions. Browser modes never automatically request a raid.
  mode: z.enum(['chat', 'manual', 'auto', 'direct']).optional(),
  raidRequestedAtMs: timestampSchema.optional(),
  estimatedCountdownSeconds: countSchema.max(120).nullable().optional(),
}).strict().superRefine((value, context) => {
  const browserMode = value.mode !== undefined && value.mode !== 'chat';
  if (!browserMode && value.candidates.some((candidate) => !languageCodeSchema.safeParse(candidate.language).success)) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'Chat candidates must use supported voting languages.' });
  }
  if (browserMode && Object.keys(value.votes).length > 0) {
    context.addIssue({ code: 'custom', path: ['votes'], message: 'Browser spins do not accept chat votes.' });
  }
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

const twitchIdSchema = z.string().min(1).max(25).regex(/^[0-9]+$/);
const controlIdentity = { channelId: twitchIdSchema, requestId: z.string().uuid() };
export const prepareRouletteSchema = z.discriminatedUnion('mode', [
  z.object({ channelId: twitchIdSchema, mode: z.literal('manual'), candidateIds: z.array(twitchIdSchema).min(1).max(100) }).strict()
    .refine((value) => new Set(value.candidateIds).size === value.candidateIds.length, { message: 'Candidates must be unique.' }),
  z.object({ channelId: twitchIdSchema, mode: z.literal('auto'), count: z.union([z.literal(6), z.literal(7)]) }).strict(),
]);
export const spinControlSchema = z.object({ ...controlIdentity, poolId: z.string().uuid() }).strict();
export const raidControlSchema = z.object({
  ...controlIdentity, toStreamerId: twitchIdSchema.optional(), sessionId: identifierSchema.optional(),
}).strict().refine((value) => (value.toStreamerId === undefined) !== (value.sessionId === undefined), {
  message: 'Provide either a destination or a chosen session.',
});
export const cancelControlSchema = z.object({ ...controlIdentity, sessionId: identifierSchema }).strict();
export const controlStatusSchema = z.object({
  channelId: twitchIdSchema, login: loginSchema, isLive: z.boolean(), viewers: countSchema,
  simulated: z.boolean(), roulette: publicRouletteStateSchema.nullable(),
}).strict();
export const preparedRouletteSchema = z.object({
  poolId: z.string().uuid(), mode: z.enum(['manual', 'auto']), candidates: z.array(candidateSchema).max(100),
  sourceViewers: countSchema, minViewers: z.number().nonnegative(), maxViewers: countSchema,
  discoveryLimited: z.boolean(), expiresAtMs: timestampSchema,
}).strict();
export const controlResultSchema = z.object({ roulette: publicRouletteStateSchema, simulated: z.boolean() }).strict();

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

// ISO 3166-1 alpha-2 country codes (complete list)
export const countryCodeSchema = z.enum([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

// Roulette mode: manual (streamer picks candidates) or auto (random similar-level streamers)
export const rouletteModeSchema = z.enum(['manual', 'auto']);

// Current flag holder info
const flagHolderSchema = z.object({
  streamerId: identifierSchema,
  displayName: z.string().min(1).max(100),
  avatarUrl: z.string().max(2048).url().startsWith('https://').nullable(),
  progress: z.number().min(0).max(100),
  maintainedSince: timestampSchema,
}).strict();

// Competitor in a flag competition
const flagCompetitorSchema = z.object({
  streamerId: identifierSchema,
  displayName: z.string().min(1).max(100),
  points: countSchema,
  avatarUrl: z.string().max(2048).url().startsWith('https://').nullable(),
}).strict();

// State of a country's flag in the competition system
export const countryFlagStateSchema = z.object({
  countryCode: countryCodeSchema,
  currentFlag: flagHolderSchema.nullable(),
  competitors: z.array(flagCompetitorSchema).max(1000),
  threshold: countSchema,
  decayRatePerHour: z.number().nonnegative(),
}).strict();

// A contribution toward capturing a flag
export const flagContributionSchema = z.object({
  streamerId: identifierSchema,
  countryCode: countryCodeSchema,
  points: countSchema,
  contributedAtMs: timestampSchema,
}).strict();

// Configuration for a roulette session
export const rouletteConfigSchema = z.object({
  mode: rouletteModeSchema,
  manualCandidates: z.array(identifierSchema).max(100),
  autoCount: z.union([z.literal(6), z.literal(7)]),
  selectedCountry: countryCodeSchema.nullable(),
}).strict();
