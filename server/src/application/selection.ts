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

// Sampling never changes the bounds, even when fewer than six channels qualify.
export function autoCandidates(sourceId: string, sourceViewers: number, live: readonly Candidate[], count: 6 | 7, random: RandomSource): Candidate[] {
  if (!Number.isSafeInteger(sourceViewers) || sourceViewers < 0) throw new Error('Invalid source viewer count.');
  const pool = [...new Map(live.filter((candidate) => candidate.streamerId !== sourceId &&
    candidate.viewers >= sourceViewers * 0.5 && candidate.viewers <= sourceViewers * 2)
    .map((candidate) => [candidate.streamerId, candidate] as const)).values()];
  const chosen: Candidate[] = [];
  while (pool.length && chosen.length < count) {
    const index = pool.length === 1 ? 0 : random.nextInt(pool.length);
    const [candidate] = pool.splice(index, 1);
    if (!candidate) throw new Error('The random source returned an invalid candidate index.');
    chosen.push(candidate);
  }
  return chosen;
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
