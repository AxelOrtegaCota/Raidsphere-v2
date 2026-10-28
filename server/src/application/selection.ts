import type { Candidate, LanguageCode, VoteCounts } from '@raidsphere/shared';
import type { RandomSource } from './ports.js';

// Winner and candidate selection (D2-02, D2-03, D2-06 rule 6).

// Distinct pool languages in order of first appearance; also the roulette:start language list.
export function poolLanguages(candidates: readonly Candidate[]): LanguageCode[] {
  return [...new Set(candidates.map((candidate) => candidate.language))];
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
