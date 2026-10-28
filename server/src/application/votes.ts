import type { LanguageCode, PublicRouletteState, VoteCounts } from '@raidsphere/shared';

// Vote acceptance (D2-04). Ignored votes are silent; the reason is for tests and debugging only.

export type VoteResult =
  | { outcome: 'accepted'; votesByUser: Record<string, LanguageCode>; votes: VoteCounts }
  | { outcome: 'ignored'; reason: 'not_voting' | 'late' | 'already_voted' | 'invalid_language' };

export function castVote(
  state: PublicRouletteState,
  votesByUser: Readonly<Record<string, LanguageCode>>,
  vote: { userId: string; language: LanguageCode },
  nowMs: number,
): VoteResult {
  if (state.status !== 'voting') return { outcome: 'ignored', reason: 'not_voting' };
  // The deadline is exclusive and measured with the server clock.
  if (state.votingEndsAtMs === null || nowMs >= state.votingEndsAtMs) return { outcome: 'ignored', reason: 'late' };
  // The first valid vote is final.
  if (Object.hasOwn(votesByUser, vote.userId)) return { outcome: 'ignored', reason: 'already_voted' };
  // An invalid vote does not use up the user's vote.
  if (!state.candidates.some((candidate) => candidate.language === vote.language)) {
    return { outcome: 'ignored', reason: 'invalid_language' };
  }
  return {
    outcome: 'accepted',
    votesByUser: { ...votesByUser, [vote.userId]: vote.language },
    votes: { ...state.votes, [vote.language]: (state.votes[vote.language] ?? 0) + 1 },
  };
}
