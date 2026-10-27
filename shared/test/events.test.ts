import { describe, expect, expectTypeOf, it } from 'vitest';
import * as publicEventContracts from '../events.js';
import { clientMessageSchema, serverEventSchema } from '../events.js';
import { candidateSchema, publicRouletteStateSchema, streamerSchema } from '../schemas.js';
import type { RouletteVotesEvent, ServerEvent, StateSnapshotEvent } from '../events.js';

// All identifiers and message content in this file are synthetic fixtures.
const candidate = {
  streamerId: 'fixture-destination', login: 'fixture_destination', displayName: 'Fixture Destination',
  avatarUrl: null, language: 'en', illustrativeCountry: 'US', viewers: 8,
  gameName: 'Fixture Category', title: 'Contract fixture',
} as const;

function event(type: string, payload: unknown, session = true) {
  return {
    version: 1, type, eventId: '00000000-0000-4000-8000-000000000001',
    channelId: 'fixture-source', occurredAtMs: 1000, sequence: 1,
    ...(session ? { sessionId: 'fixture-session' } : {}), payload,
  };
}

const roulette = {
  sessionId: 'fixture-session', fromStreamerId: 'fixture-source', status: 'voting',
  candidates: [candidate], votes: { en: 1 }, createdAtMs: 1000,
  votingEndsAtMs: 31000, chosenCandidate: null,
};
const windowState = {
  channelId: 'fixture-source', status: 'active', targetLanguage: 'en',
  activatedAtMs: 1000, expiresAtMs: 901000,
};
const bubble = {
  messageId: 'fixture-message', userId: 'fixture-chatter', displayName: 'Fixture Chatter',
  original: 'Hello Kappa', fragments: [
    { type: 'text', text: 'Hello ' }, { type: 'emote', text: 'Kappa', emoteId: 'fixture-emote' },
  ],
  fromLanguage: 'en', toLanguage: 'es', illustrativeCountry: null,
  receivedAtMs: 1000, status: 'completed', translated: 'Hola Kappa',
};

const validEvents: Record<ServerEvent['type'], unknown> = {
  'roulette:start': event('roulette:start', { candidates: [candidate], languages: ['en'], votingEndsAtMs: 31000 }),
  'roulette:votes': event('roulette:votes', { votes: { en: 1 }, totalVotes: 1 }),
  'roulette:chosen': event('roulette:chosen', { candidate, winningLanguage: 'en', fromCountry: 'MX', toCountry: 'US' }),
  'raid:started': event('raid:started', {
    toStreamerId: candidate.streamerId, toLogin: candidate.login, requestedAtMs: 1000, estimatedCountdownSeconds: null,
  }),
  'raid:cancelled': event('raid:cancelled', { reason: 'user_cancelled' }),
  'raid:arrived': {
    ...event('raid:arrived', {
      fromStreamerId: 'fixture-source', fromLogin: 'fixture_source', toStreamerId: candidate.streamerId,
      viewers: 5, sourceLanguage: 'es', arrivedAtMs: 1000,
    }), channelId: candidate.streamerId,
  },
  'translate:bubble': event('translate:bubble', bubble, false),
  'translate:remove': event('translate:remove', { messageId: 'fixture-message' }, false),
  'translate:clear': event('translate:clear', { scope: 'channel' }, false),
  'translation:window': event('translation:window', windowState, false),
  'state:snapshot': event('state:snapshot', { roulette, translationWindow: windowState }, false),
  error: event('error', { code: 'RAID_OUTCOME_UNKNOWN', message: 'Arrival has not been confirmed.', recoverable: false }),
};

describe('server event boundary', () => {
  it.each(Object.entries(validEvents))('accepts the %s contract and preserves its JSON representation', (_type, value) => {
    expect(serverEventSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('rejects unknown events, versions, fields, and missing session identities', () => {
    expect(serverEventSchema.safeParse(event('state:request', {})).success).toBe(false);
    expect(serverEventSchema.safeParse({ ...event('roulette:votes', { votes: {}, totalVotes: 0 }), version: 2 }).success).toBe(false);
    expect(serverEventSchema.safeParse({ ...event('roulette:votes', { votes: {}, totalVotes: 0 }), tokens: {} }).success).toBe(false);
    expect(serverEventSchema.safeParse(event('roulette:votes', { votes: {}, totalVotes: 0 }, false)).success).toBe(false);
  });

  it('rejects inconsistent totals, invalid counts, and unsupported language keys', () => {
    expect(serverEventSchema.safeParse(event('roulette:votes', { votes: { en: 2 }, totalVotes: 1 })).success).toBe(false);
    expect(serverEventSchema.safeParse(event('roulette:votes', { votes: { en: -1 }, totalVotes: 0 })).success).toBe(false);
    expect(serverEventSchema.safeParse(event('roulette:votes', { votes: { Spanish: 1 }, totalVotes: 1 })).success).toBe(false);
  });

  it('rejects duplicate or unavailable voting languages and expired start deadlines', () => {
    for (const payload of [
      { candidates: [candidate], languages: ['en', 'en'], votingEndsAtMs: 31000 },
      { candidates: [candidate, candidate], languages: ['en'], votingEndsAtMs: 31000 },
      { candidates: [candidate], languages: ['es'], votingEndsAtMs: 31000 },
      { candidates: [candidate], languages: ['en'], votingEndsAtMs: 1000 },
    ]) expect(serverEventSchema.safeParse(event('roulette:start', payload)).success).toBe(false);
  });

  it('rejects a candidate from a different winning language', () => {
    expect(serverEventSchema.safeParse(event('roulette:chosen', {
      candidate, winningLanguage: 'es', fromCountry: 'MX', toCountry: 'US',
    })).success).toBe(false);
  });

  it('rejects another channel in translation windows and snapshots', () => {
    const otherWindow = { ...windowState, channelId: 'fixture-other' };
    expect(serverEventSchema.safeParse(event('translation:window', otherWindow, false)).success).toBe(false);
    expect(serverEventSchema.safeParse(event('state:snapshot', { roulette: null, translationWindow: otherWindow }, false)).success).toBe(false);
    expect(serverEventSchema.safeParse(event('state:snapshot', {
      roulette: { ...roulette, fromStreamerId: 'fixture-other' }, translationWindow: null,
    }, false)).success).toBe(false);
  });

  it('requires raid arrivals to be routed to the destination', () => {
    expect(serverEventSchema.safeParse(event('raid:arrived', {
      fromStreamerId: 'fixture-source', fromLogin: 'fixture_source', toStreamerId: 'fixture-destination',
      viewers: 1, sourceLanguage: 'es', arrivedAtMs: 1000,
    })).success).toBe(false);
  });

  it('does not treat failure or uncertainty as confirmed cancellation', () => {
    for (const reason of ['timeout', 'api_error', 'unknown']) {
      expect(serverEventSchema.safeParse(event('raid:cancelled', { reason })).success).toBe(false);
    }
  });
});

describe('public state and translation', () => {
  it('rejects private state at nested public boundaries', () => {
    expect(candidateSchema.safeParse({ ...candidate, accessToken: 'synthetic-forbidden-field' }).success).toBe(false);
    expect(publicRouletteStateSchema.safeParse({ ...roulette, votesByUser: {} }).success).toBe(false);
  });

  it('requires a deadline while voting and a candidate after selection', () => {
    expect(publicRouletteStateSchema.safeParse({ ...roulette, votingEndsAtMs: null }).success).toBe(false);
    expect(publicRouletteStateSchema.safeParse({ ...roulette, status: 'raid_pending' }).success).toBe(false);
    expect(publicRouletteStateSchema.safeParse({ ...roulette, status: 'chosen', chosenCandidate: candidate }).success).toBe(true);
  });

  it('rejects reversed viewer preferences', () => {
    expect(streamerSchema.safeParse({
      id: 'fixture-source', login: 'fixture_source', displayName: 'Fixture Source', avatarUrl: null,
      language: 'es', minViewers: 20, maxViewers: 5, acceptsOtherLanguages: true, reputation: 0,
    }).success).toBe(false);
  });

  it('supports original-first updates and an explicit unavailable result', () => {
    expect(serverEventSchema.safeParse(event('translate:bubble', {
      ...bubble, status: 'pending', fromLanguage: null, translated: null,
    }, false)).success).toBe(true);
    expect(serverEventSchema.safeParse(event('translate:bubble', {
      ...bubble, status: 'unavailable', translated: null, reason: 'timeout',
    }, false)).success).toBe(true);
  });

  it('rejects fabricated translations and fragments that lose original content', () => {
    expect(serverEventSchema.safeParse(event('translate:bubble', { ...bubble, status: 'pending' }, false)).success).toBe(false);
    expect(serverEventSchema.safeParse(event('translate:bubble', { ...bubble, translated: '' }, false)).success).toBe(false);
    expect(serverEventSchema.safeParse(event('translate:bubble', {
      ...bubble, fragments: [{ type: 'text', text: 'Hello' }],
    }, false)).success).toBe(false);
  });

  it('requires a user identity for user-specific moderation clearing', () => {
    expect(serverEventSchema.safeParse(event('translate:clear', { scope: 'user' }, false)).success).toBe(false);
  });
});

describe('overlay permissions', () => {
  it('accepts only the future viewing handshake, never a control command', () => {
    const message = {
      version: 1, type: 'auth', payload: { channelId: 'fixture-source', viewingCredential: 'x'.repeat(32) },
    };
    expect(clientMessageSchema.safeParse(message).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...message, type: 'roulette:start' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...message, payload: { ...message.payload, canControl: true } }).success).toBe(false);
  });
});

describe('authoritative event validation API', () => {
  it('exports only the canonical runtime event validators', () => {
    expect(Object.keys(publicEventContracts).sort()).toEqual(['clientMessageSchema', 'serverEventSchema']);
  });

  it('preserves named event types and validates through the public boundary', () => {
    expectTypeOf<RouletteVotesEvent>().toEqualTypeOf<Extract<ServerEvent, { type: 'roulette:votes' }>>();
    expectTypeOf<StateSnapshotEvent>().toEqualTypeOf<Extract<ServerEvent, { type: 'state:snapshot' }>>();
    expect(publicEventContracts.serverEventSchema.safeParse(
      event('roulette:votes', { votes: { en: 2 }, totalVotes: 1 }),
    ).success).toBe(false);
    expect(() => publicEventContracts.serverEventSchema.parse(
      event('roulette:votes', { votes: { en: 2 }, totalVotes: 1 }),
    )).toThrow();
  });
});

describe('snapshot invariants through the canonical event validator', () => {
  const snapshot = (state: unknown) => event('state:snapshot', { roulette: state, translationWindow: null }, false);

  it.each(['voting', 'selecting'] as const)('requires a pool, deadline, and no premature selection in %s', (status) => {
    expect(serverEventSchema.safeParse(snapshot({ ...roulette, status })).success).toBe(true);
    for (const state of [
      { ...roulette, status, candidates: [], votes: {} },
      { ...roulette, status, votingEndsAtMs: null },
      { ...roulette, status, chosenCandidate: candidate },
    ]) expect(serverEventSchema.safeParse(snapshot(state)).success).toBe(false);
  });

  it('rejects votes for languages outside the session pool, including zero counts', () => {
    for (const votes of [{ es: 1 }, { en: 1, es: 0 }]) {
      expect(serverEventSchema.safeParse(snapshot({ ...roulette, votes })).success).toBe(false);
    }
  });

  it.each(['chosen', 'raid_pending', 'done', 'unknown'] as const)('requires a matching selected identity and language in %s', (status) => {
    const selected = { ...roulette, status, chosenCandidate: candidate };
    expect(serverEventSchema.safeParse(snapshot(selected)).success).toBe(true);
    for (const chosenCandidate of [
      null,
      { ...candidate, streamerId: 'fixture-other' },
      { ...candidate, language: 'es' },
    ]) expect(serverEventSchema.safeParse(snapshot({ ...selected, chosenCandidate })).success).toBe(false);
  });

  it('allows refreshed display metadata without changing selected identity or language', () => {
    expect(serverEventSchema.safeParse(snapshot({
      ...roulette, status: 'chosen',
      chosenCandidate: { ...candidate, viewers: 12, title: 'Refreshed fixture title' },
    })).success).toBe(true);
  });

  it.each(['cancelled', 'failed'] as const)('allows an empty %s snapshot only without votes or selection', (status) => {
    const state = { ...roulette, status, candidates: [], votes: {}, votingEndsAtMs: null, chosenCandidate: null };
    expect(serverEventSchema.safeParse(snapshot(state)).success).toBe(true);
    expect(serverEventSchema.safeParse(snapshot({ ...state, votes: { en: 0 } })).success).toBe(false);
    expect(serverEventSchema.safeParse(snapshot({ ...state, chosenCandidate: candidate })).success).toBe(false);
    expect(serverEventSchema.safeParse(snapshot({ ...roulette, status, chosenCandidate: candidate })).success).toBe(true);
  });
});
