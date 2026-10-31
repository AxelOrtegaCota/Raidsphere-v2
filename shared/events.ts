import { z } from 'zod';
import {
  PROTOCOL_VERSION, candidateSchema, countSchema, identifierSchema,
  illustrativeCountrySchema, languageCodeSchema, loginSchema,
  publicRouletteStateSchema, timestampSchema, translationBubbleSchema,
  translationWindowSchema, voteCountsSchema,
} from './schemas.js';

function notification<TName extends string, TPayload extends z.ZodType>(type: TName, payload: TPayload) {
  return z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    eventId: z.string().uuid(),
    channelId: identifierSchema,
    sessionId: identifierSchema.optional(),
    occurredAtMs: timestampSchema,
    // Channel-scoped, within one server lifetime; this is not a replay cursor.
    sequence: countSchema,
    payload,
  }).strict();
}

const rouletteStartEventSchema = notification('roulette:start', z.object({
  candidates: z.array(candidateSchema).min(1).max(100),
  languages: z.array(languageCodeSchema).min(1).max(languageCodeSchema.options.length),
  votingEndsAtMs: timestampSchema,
}).strict()).extend({ sessionId: identifierSchema });

const rouletteVotesEventSchema = notification('roulette:votes', z.object({
  votes: voteCountsSchema,
  totalVotes: countSchema,
}).strict()).extend({ sessionId: identifierSchema });

const rouletteChosenEventSchema = notification('roulette:chosen', z.object({
  candidate: candidateSchema,
  winningLanguage: languageCodeSchema,
  fromCountry: illustrativeCountrySchema.nullable(),
  toCountry: illustrativeCountrySchema.nullable(),
}).strict()).extend({ sessionId: identifierSchema });

const raidStartedEventSchema = notification('raid:started', z.object({
  toStreamerId: identifierSchema,
  toLogin: loginSchema,
  requestedAtMs: timestampSchema,
  estimatedCountdownSeconds: countSchema.max(120).nullable(),
}).strict()).extend({ sessionId: identifierSchema });

const raidCancelledEventSchema = notification('raid:cancelled', z.object({
  reason: z.enum(['user_cancelled', 'session_cancelled_before_request']),
}).strict()).extend({ sessionId: identifierSchema });

const raidArrivedEventSchema = notification('raid:arrived', z.object({
  fromStreamerId: identifierSchema,
  fromLogin: loginSchema,
  toStreamerId: identifierSchema,
  viewers: countSchema,
  sourceLanguage: languageCodeSchema,
  arrivedAtMs: timestampSchema,
}).strict()).extend({ sessionId: identifierSchema });

const translateBubbleEventSchema = notification('translate:bubble', translationBubbleSchema);
const translateRemoveEventSchema = notification('translate:remove', z.object({ messageId: identifierSchema }).strict());
const translateClearEventSchema = notification('translate:clear', z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('channel') }).strict(),
  z.object({ scope: z.literal('user'), userId: identifierSchema }).strict(),
]));
const translationWindowEventSchema = notification('translation:window', translationWindowSchema);

const stateSnapshotEventSchema = notification('state:snapshot', z.object({
  roulette: publicRouletteStateSchema.nullable(),
  translationWindow: translationWindowSchema.nullable(),
}).strict());

const errorEventSchema = notification('error', z.object({
  code: z.enum([
    'UNAUTHORIZED', 'INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'AUTHORIZATION_UNAVAILABLE',
    'RAID_REJECTED', 'RAID_OUTCOME_UNKNOWN', 'NO_ELIGIBLE_CANDIDATES', 'INTERNAL_ERROR',
  ]),
  message: z.string().min(1).max(200),
  recoverable: z.boolean(),
}).strict());

// Roulette configuration event - streamer configures roulette mode
const rouletteConfigureEventSchema = notification('roulette:configure', z.object({
  mode: z.enum(['manual', 'auto']),
  candidates: z.array(identifierSchema).max(100).optional(),
  autoCount: z.union([z.literal(6), z.literal(7)]).optional(),
  selectedCountry: illustrativeCountrySchema.optional(),
}).strict());

// Flag competition events
const flagContributionEventSchema = notification('flag:contribution', z.object({
  streamerId: identifierSchema,
  countryCode: illustrativeCountrySchema,
  points: countSchema,
  newTotal: countSchema,
  progress: z.number().min(0).max(100),
}).strict());

const flagClaimedEventSchema = notification('flag:claimed', z.object({
  countryCode: illustrativeCountrySchema,
  streamerId: identifierSchema,
  displayName: z.string().min(1).max(100),
  claimedAtMs: timestampSchema,
}).strict());

const flagOvertakenEventSchema = notification('flag:overtaken', z.object({
  countryCode: illustrativeCountrySchema,
  previousOwner: identifierSchema,
  newOwner: identifierSchema,
  margin: countSchema,
}).strict());

const flagDecayedEventSchema = notification('flag:decayed', z.object({
  countryCode: illustrativeCountrySchema,
  streamerId: identifierSchema,
  reason: z.enum(['decay', 'overtaken']),
}).strict());

// Globe snapshot event - all country flags for globe rendering
const globeFlagsEventSchema = notification('globe:flags', z.object({
  flags: z.array(z.object({
    countryCode: illustrativeCountrySchema,
    ownerStreamerId: identifierSchema,
    ownerDisplayName: z.string().min(1).max(100),
    progress: z.number().min(0).max(100),
    color: z.string().min(4).max(9).regex(/^#[0-9a-fA-F]{3,8}$/),
  }).strict()).max(200),
}).strict());

const serverEventUnion = z.discriminatedUnion('type', [
  rouletteStartEventSchema, rouletteVotesEventSchema, rouletteChosenEventSchema,
  rouletteConfigureEventSchema,
  raidStartedEventSchema, raidCancelledEventSchema, raidArrivedEventSchema,
  translateBubbleEventSchema, translateRemoveEventSchema, translateClearEventSchema,
  translationWindowEventSchema, stateSnapshotEventSchema, errorEventSchema,
  flagContributionEventSchema, flagClaimedEventSchema, flagOvertakenEventSchema,
  flagDecayedEventSchema, globeFlagsEventSchema,
]);

// Authoritative server notification validator. Structural event schemas stay private
// so consumers cannot accidentally bypass cross-field checks.
export const serverEventSchema = serverEventUnion.superRefine((event, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({
    code: 'custom', path, message,
  });
  if (event.type === 'roulette:start') {
    const languages = new Set(event.payload.languages);
    if (new Set(event.payload.candidates.map((candidate) => candidate.streamerId)).size !== event.payload.candidates.length) {
      issue(['payload', 'candidates'], 'Candidate identities must be unique.');
    }
    if (languages.size !== event.payload.languages.length) issue(['payload', 'languages'], 'Languages must be unique.');
    if (event.payload.candidates.some((candidate) => !languages.has(candidate.language)) ||
        event.payload.languages.some((language) => !event.payload.candidates.some((candidate) => candidate.language === language))) {
      issue(['payload', 'languages'], 'Voting languages must match candidate languages.');
    }
    if (event.payload.votingEndsAtMs <= event.occurredAtMs) issue(['payload', 'votingEndsAtMs'], 'Voting must end after session start.');
  }
  if (event.type === 'roulette:votes') {
    const total = Object.values(event.payload.votes).reduce((sum, count) => sum + (count ?? 0), 0);
    if (total !== event.payload.totalVotes) issue(['payload', 'totalVotes'], 'The total must match the aggregate counts.');
  }
  if (event.type === 'roulette:chosen' && event.payload.candidate.language !== event.payload.winningLanguage) {
    issue(['payload', 'winningLanguage'], 'The selected candidate must use the winning language.');
  }
  if (event.type === 'roulette:chosen' && event.payload.toCountry !== event.payload.candidate.illustrativeCountry) {
    issue(['payload', 'toCountry'], 'The destination country must match the selected candidate.');
  }
  if (event.type === 'error') {
    const isRaidError = event.payload.code === 'RAID_REJECTED' || event.payload.code === 'RAID_OUTCOME_UNKNOWN';
    if (isRaidError && event.sessionId === undefined) issue(['sessionId'], 'Raid errors must identify their session.');
    if (event.payload.code === 'NO_ELIGIBLE_CANDIDATES' && event.sessionId !== undefined) {
      issue(['sessionId'], 'No session exists when no candidate is eligible.');
    }
  }
  if (event.type === 'raid:arrived' && event.payload.toStreamerId !== event.channelId) {
    issue(['channelId'], 'An arrival must target the destination channel.');
  }
  if (event.type === 'translation:window' && event.payload.channelId !== event.channelId) {
    issue(['channelId'], 'The translation window must target its own channel.');
  }
  if (event.type === 'state:snapshot') {
    if (event.payload.translationWindow && event.payload.translationWindow.channelId !== event.channelId) {
      issue(['payload', 'translationWindow'], 'A snapshot must not contain another channel window.');
    }
    if (event.payload.roulette && event.payload.roulette.fromStreamerId !== event.channelId) {
      issue(['payload', 'roulette'], 'A snapshot must not contain another channel roulette.');
    }
  }
});

// Future viewing handshake only. No control command shares this capability.
// The Phase 1 server rejects upgrades until authorization is implemented.
const overlayAuthMessageSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal('auth'),
  payload: z.object({
    channelId: identifierSchema,
    viewingCredential: z.string().min(16).max(512),
  }).strict(),
}).strict();

// Authoritative client message validator; this is not credential verification.
export const clientMessageSchema = overlayAuthMessageSchema;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RouletteStartEvent = z.infer<typeof rouletteStartEventSchema>;
export type RouletteVotesEvent = z.infer<typeof rouletteVotesEventSchema>;
export type RouletteChosenEvent = z.infer<typeof rouletteChosenEventSchema>;
export type RaidStartedEvent = z.infer<typeof raidStartedEventSchema>;
export type RaidCancelledEvent = z.infer<typeof raidCancelledEventSchema>;
export type RaidArrivedEvent = z.infer<typeof raidArrivedEventSchema>;
export type TranslateBubbleEvent = z.infer<typeof translateBubbleEventSchema>;
export type TranslateRemoveEvent = z.infer<typeof translateRemoveEventSchema>;
export type TranslateClearEvent = z.infer<typeof translateClearEventSchema>;
export type TranslationWindowEvent = z.infer<typeof translationWindowEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type StateSnapshotEvent = z.infer<typeof stateSnapshotEventSchema>;
export type RouletteConfigureEvent = z.infer<typeof rouletteConfigureEventSchema>;
export type FlagContributionEvent = z.infer<typeof flagContributionEventSchema>;
export type FlagClaimedEvent = z.infer<typeof flagClaimedEventSchema>;
export type FlagOvertakenEvent = z.infer<typeof flagOvertakenEventSchema>;
export type FlagDecayedEvent = z.infer<typeof flagDecayedEventSchema>;
export type GlobeFlagsEvent = z.infer<typeof globeFlagsEventSchema>;
