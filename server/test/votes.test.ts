import { describe, expect, it } from 'vitest';
import type { Candidate, LanguageCode, PublicRouletteState } from '@raidsphere/shared';
import { castVote } from '../src/application/votes.js';

// All identifiers in this file are synthetic fixtures.
const candidate = (language: LanguageCode, id: string): Candidate => ({
  streamerId: id, login: id, displayName: 'Demo Candidate', avatarUrl: null, language,
  illustrativeCountry: null, viewers: 10, gameName: 'Synthetic Category', title: '[Synthetic] Demo',
});

const state: PublicRouletteState = {
  sessionId: 'session-a', fromStreamerId: 'rsdemo_es_01', status: 'voting',
  candidates: [candidate('en', 'rsdemo_en_01'), candidate('ja', 'rsdemo_ja_01')],
  votes: {}, createdAtMs: 1000, votingEndsAtMs: 31000, chosenCandidate: null,
};

describe('vote acceptance', () => {
  it('accepts a first valid vote and returns matching counts', () => {
    expect(castVote(state, {}, { userId: 'user-1', language: 'en' }, 2000)).toEqual({
      outcome: 'accepted', votesByUser: { 'user-1': 'en' }, votes: { en: 1 },
    });
  });

  it('keeps the first valid vote final', () => {
    const voted = { ...state, votes: { en: 1 } };
    expect(castVote(voted, { 'user-1': 'en' }, { userId: 'user-1', language: 'ja' }, 2000))
      .toEqual({ outcome: 'ignored', reason: 'already_voted' });
  });

  it('does not use up the vote on an invalid language', () => {
    expect(castVote(state, {}, { userId: 'user-1', language: 'ko' }, 2000))
      .toEqual({ outcome: 'ignored', reason: 'invalid_language' });
    expect(castVote(state, {}, { userId: 'user-1', language: 'ja' }, 2000).outcome).toBe('accepted');
  });

  it('ignores votes at or after the deadline', () => {
    for (const nowMs of [31000, 31001]) {
      expect(castVote(state, {}, { userId: 'user-1', language: 'en' }, nowMs)).toEqual({ outcome: 'ignored', reason: 'late' });
    }
    expect(castVote(state, {}, { userId: 'user-1', language: 'en' }, 30999).outcome).toBe('accepted');
  });

  it('ignores votes outside the voting state', () => {
    expect(castVote({ ...state, status: 'selecting' }, {}, { userId: 'user-1', language: 'en' }, 2000))
      .toEqual({ outcome: 'ignored', reason: 'not_voting' });
  });

  it('counts independently per user without changing its inputs', () => {
    const votesByUser = { 'user-1': 'en' } as const;
    const voted = { ...state, votes: { en: 1 } };
    const result = castVote(voted, votesByUser, { userId: 'user-2', language: 'en' }, 2000);
    expect(result).toEqual({ outcome: 'accepted', votesByUser: { 'user-1': 'en', 'user-2': 'en' }, votes: { en: 2 } });
    expect(votesByUser).toEqual({ 'user-1': 'en' });
    expect(voted.votes).toEqual({ en: 1 });
  });
});
