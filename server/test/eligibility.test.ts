import { describe, expect, it } from 'vitest';
import type { LanguageCode, Streamer } from '@raidsphere/shared';
import { MAX_POOL_SIZE, buildPool, eligibleChannels } from '../src/application/eligibility.js';
import type { LiveChannel } from '../src/application/ports.js';
import { syntheticLiveChannels, syntheticStreamers } from '../src/simulation/fixtures.js';
import { ScriptedRandom } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures.
const source: Streamer = {
  id: 'rsdemo_source', login: 'rsdemo_source', displayName: 'Demo Source', avatarUrl: null,
  language: 'es', minViewers: 10, maxViewers: 20, acceptsOtherLanguages: true, reputation: 0,
};

function channel(id: string, viewers: number, language: LanguageCode = 'en', acceptsOtherLanguages = true): LiveChannel {
  return {
    streamer: { ...source, id, login: id, displayName: 'Demo Channel', language, acceptsOtherLanguages },
    viewers, gameName: 'Synthetic Category', title: '[Synthetic] Demo', illustrativeCountry: null,
  };
}

const ids = (channels: readonly { streamer: { id: string } }[]) => channels.map((entry) => entry.streamer.id);

describe('candidate eligibility', () => {
  it('excludes the source channel', () => {
    expect(ids(eligibleChannels(source, [channel('rsdemo_source', 15, 'es'), channel('rsdemo_a', 15)]))).toEqual(['rsdemo_a']);
  });

  it('applies the source viewer range inclusively', () => {
    const live = [channel('rsdemo_9', 9), channel('rsdemo_10', 10), channel('rsdemo_20', 20), channel('rsdemo_21', 21)];
    expect(ids(eligibleChannels(source, live))).toEqual(['rsdemo_10', 'rsdemo_20']);
  });

  it('respects destinations that only accept their own language', () => {
    const live = [channel('rsdemo_same', 15, 'es', false), channel('rsdemo_other', 15, 'de', false)];
    expect(ids(eligibleChannels(source, live))).toEqual(['rsdemo_same']);
  });

  it('gives the demo source a small pool across several languages', () => {
    const demoSource = syntheticStreamers.find((streamer) => streamer.id === 'rsdemo_es_01');
    if (!demoSource) throw new Error('The demo source fixture is missing.');
    expect(ids(eligibleChannels(demoSource, syntheticLiveChannels))).toEqual([
      'rsdemo_en_01', 'rsdemo_es_02', 'rsdemo_pt_01', 'rsdemo_ja_01', 'rsdemo_ko_02',
    ]);
  });
});

describe('pool construction', () => {
  it('keeps order and uses no randomness up to the maximum', () => {
    const live = [channel('rsdemo_a', 12, 'en'), channel('rsdemo_b', 14, 'pt')];
    const pool = buildPool(live, new ScriptedRandom([]));
    expect(pool.map((candidate) => [candidate.streamerId, candidate.language, candidate.viewers])).toEqual([
      ['rsdemo_a', 'en', 12], ['rsdemo_b', 'pt', 14],
    ]);
  });

  it('samples the maximum number of distinct eligible channels above it', () => {
    const live = Array.from({ length: 150 }, (_, index) => channel(`rsdemo_${index}`, 15));
    const pool = buildPool(live, new ScriptedRandom(Array.from({ length: MAX_POOL_SIZE }, (_, index) => index % 7)));
    const pooled = pool.map((candidate) => candidate.streamerId);
    expect(pooled).toHaveLength(MAX_POOL_SIZE);
    expect(new Set(pooled).size).toBe(MAX_POOL_SIZE);
    expect(pooled.every((id) => ids(live).includes(id))).toBe(true);
  });
});
