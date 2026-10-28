import { describe, expect, it } from 'vitest';
import { candidateSchema, languageCodeSchema, streamerSchema } from '@raidsphere/shared';
import { SYNTHETIC_PREFIX, syntheticLiveChannels, syntheticStreamers } from '../src/simulation/fixtures.js';

describe('synthetic fixtures', () => {
  it('are valid, unique, and unmistakably synthetic', () => {
    const ids = syntheticStreamers.map((streamer) => streamer.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const streamer of syntheticStreamers) {
      expect(streamerSchema.safeParse(streamer).success).toBe(true);
      expect(streamer.id.startsWith(SYNTHETIC_PREFIX) && streamer.login === streamer.id).toBe(true);
      expect(streamer.displayName.startsWith('Demo ')).toBe(true);
      expect(streamer.avatarUrl).toBeNull();
    }
  });

  it('provide 3 to 5 channels for every supported language', () => {
    for (const language of languageCodeSchema.options) {
      const count = syntheticStreamers.filter((streamer) => streamer.language === language).length;
      expect(count >= 3 && count <= 5).toBe(true);
    }
  });

  it('carry everything a public candidate needs', () => {
    for (const { streamer, viewers, gameName, title, illustrativeCountry } of syntheticLiveChannels) {
      expect(title.startsWith('[Synthetic] ')).toBe(true);
      expect(candidateSchema.safeParse({
        streamerId: streamer.id, login: streamer.login, displayName: streamer.displayName,
        avatarUrl: streamer.avatarUrl, language: streamer.language, illustrativeCountry, viewers, gameName, title,
      }).success).toBe(true);
    }
  });
});
