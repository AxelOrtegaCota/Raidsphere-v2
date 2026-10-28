import type { Candidate, Streamer } from '@raidsphere/shared';
import type { LiveChannel, RandomSource } from './ports.js';

// Candidate eligibility and pool construction (D2-06). Filters are never relaxed.

export const MAX_POOL_SIZE = 100;

export function eligibleChannels(source: Streamer, live: readonly LiveChannel[]): LiveChannel[] {
  return live.filter(({ streamer, viewers }) =>
    streamer.id !== source.id &&
    viewers >= source.minViewers && viewers <= source.maxViewers &&
    (streamer.acceptsOtherLanguages || streamer.language === source.language));
}

export function toCandidate({ streamer, viewers, gameName, title, illustrativeCountry }: LiveChannel): Candidate {
  return {
    streamerId: streamer.id, login: streamer.login, displayName: streamer.displayName,
    avatarUrl: streamer.avatarUrl, language: streamer.language, illustrativeCountry, viewers, gameName, title,
  };
}

// Keeps input order up to the maximum; above it, draws a uniform sample (partial Fisher–Yates).
export function buildPool(eligible: readonly LiveChannel[], random: RandomSource): Candidate[] {
  const channels = [...eligible];
  if (channels.length > MAX_POOL_SIZE) {
    for (let index = 0; index < MAX_POOL_SIZE; index += 1) {
      const swap = index + random.nextInt(channels.length - index);
      const current = channels[index];
      const picked = channels[swap];
      if (!current || !picked) throw new Error('The pool sample index is out of range.');
      channels[index] = picked;
      channels[swap] = current;
    }
    channels.length = MAX_POOL_SIZE;
  }
  return channels.map(toCandidate);
}
