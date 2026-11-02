import type { Candidate, LanguageCode, VoteCounts } from '@raidsphere/shared';
import { languageCodeSchema } from '@raidsphere/shared';
import type { RandomSource } from './ports.js';

// Winner and candidate selection (D2-02, D2-03, D2-06 rule 6).

// Distinct pool languages in order of first appearance; also the roulette:start language list.
export function poolLanguages(candidates: readonly Candidate[]): LanguageCode[] {
  return [...new Set(candidates.flatMap((candidate) => {
    const parsed = languageCodeSchema.safeParse(candidate.language);
    return parsed.success ? [parsed.data] : [];
  }))];
}

export function manualCandidates(sourceId: string, ids: readonly string[], live: readonly Candidate[]): Candidate[] {
  if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length || ids.includes(sourceId)) {
    throw new Error('Select unique live destinations other than your own channel.');
  }
  return ids.map((id) => {
    const candidate = live.find((entry) => entry.streamerId === id);
    if (!candidate) throw new Error('A selected destination is no longer live.');
    return candidate;
  });
}

export const AUTO_VIEWER_TIERS = [
  { minViewers: 0, maxViewers: 10 },
  { minViewers: 11, maxViewers: 50 },
  { minViewers: 51, maxViewers: 100 },
  { minViewers: 101, maxViewers: 250 },
  { minViewers: 251, maxViewers: 500 },
  { minViewers: 501, maxViewers: 1_000 },
  { minViewers: 1_001, maxViewers: Number.POSITIVE_INFINITY },
] as const;

// Saved preferences must be applied by the caller before tiering. Only local buckets mutate.
export function autoCandidates(sourceId: string, live: readonly Candidate[], count: 6 | 7, random: RandomSource): Candidate[] {
  const pool = [...new Map(live.filter((candidate) => candidate.streamerId !== sourceId)
    .map((candidate) => [candidate.streamerId, candidate] as const)).values()];
  const buckets = AUTO_VIEWER_TIERS.map(({ minViewers, maxViewers }) =>
    pool.filter((candidate) => candidate.viewers >= minViewers && candidate.viewers <= maxViewers));
  const chosen: Candidate[] = [];
  const pickPass = (): boolean => {
    const before = chosen.length;
    for (const bucket of buckets) {
      if (chosen.length === count) break;
      if (!bucket.length) continue;
      const index = bucket.length === 1 ? 0 : random.nextInt(bucket.length);
      const [candidate] = bucket.splice(index, 1);
      if (!candidate) throw new Error('The random source returned an invalid candidate index.');
      chosen.push(candidate);
    }
    return chosen.length > before;
  };
  // First cover each non-empty tier; further passes fill gaps in ascending round-robin order.
  while (chosen.length < count) {
    if (!pickPass()) break;
  }
  return chosen.sort((a, b) => a.viewers - b.viewers);
}

// Draws uniformly among the languages sharing the highest count. With zero votes every
// language is tied at zero, so D2-03 follows from the same rule as D2-02.
export function winningLanguage(votes: VoteCounts, languages: readonly LanguageCode[], random: RandomSource): LanguageCode {
  const highest = Math.max(...languages.map((language) => votes[language] ?? 0));
  return drawOne(languages.filter((language) => (votes[language] ?? 0) === highest), random);
}

export function pickCandidate(candidates: readonly Candidate[], language: LanguageCode, random: RandomSource): Candidate {
  return drawOne(candidates.filter((candidate) => candidate.language === language), random);
}

// A single option needs no draw, so tests only script draws that involve a real choice.
function drawOne<T>(options: readonly T[], random: RandomSource): T {
  if (options.length === 0) throw new Error('There is nothing to draw from.');
  const option = options[options.length === 1 ? 0 : random.nextInt(options.length)];
  if (option === undefined) throw new Error('The random source returned an index out of range.');
  return option;
}
