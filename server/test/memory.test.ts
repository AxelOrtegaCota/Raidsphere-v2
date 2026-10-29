import { describe, expect, it } from 'vitest';
import type { Candidate, LanguageCode, Streamer } from '@raidsphere/shared';
import type { StoredRouletteSession } from '../src/persistence/contracts.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from '../src/persistence/memory.js';

// All identifiers in this file are synthetic fixtures.
const candidate = (language: LanguageCode, id: string): Candidate => ({
  streamerId: id, login: id, displayName: 'Demo Candidate', avatarUrl: null, language,
  illustrativeCountry: null, viewers: 10, gameName: 'Synthetic Category', title: '[Synthetic] Demo',
});
const pool = [candidate('en', 'rsdemo_en_01'), candidate('es', 'rsdemo_es_02')];

function voting(
  sessionId: string, version: number, votesByUser: Record<string, LanguageCode> = {}, fromStreamerId = 'rsdemo_es_01',
): StoredRouletteSession {
  const votes: Partial<Record<LanguageCode, number>> = {};
  for (const language of Object.values(votesByUser)) votes[language] = (votes[language] ?? 0) + 1;
  return {
    version, votesByUser,
    publicState: {
      sessionId, fromStreamerId, status: 'voting', candidates: pool, votes,
      createdAtMs: 1000, votingEndsAtMs: 31000, chosenCandidate: null,
    },
  };
}

const cancelled = (session: StoredRouletteSession): StoredRouletteSession => ({
  ...session, version: session.version + 1, publicState: { ...session.publicState, status: 'cancelled' },
});

describe('in-memory roulette repository', () => {
  it('creates a session and finds it as active and latest', async () => {
    const repository = new InMemoryRouletteRepository();
    expect(await repository.findLatestByChannel('rsdemo_es_01')).toBeNull();
    expect(await repository.compareAndSave(voting('session-a', 1), null)).toBe(true);
    expect((await repository.findActiveByChannel('rsdemo_es_01'))?.publicState.sessionId).toBe('session-a');
    expect((await repository.findLatestByChannel('rsdemo_es_01'))?.publicState.sessionId).toBe('session-a');
  });

  it('allows only one active session per channel, independently per channel', async () => {
    const repository = new InMemoryRouletteRepository();
    await repository.compareAndSave(voting('session-a', 1), null);
    expect(await repository.compareAndSave(voting('session-b', 1), null)).toBe(false);
    expect(await repository.compareAndSave(voting('session-c', 1, {}, 'rsdemo_en_02'), null)).toBe(true);
  });

  it('updates only the same session at the expected version', async () => {
    const repository = new InMemoryRouletteRepository();
    await repository.compareAndSave(voting('session-a', 1), null);
    expect(await repository.compareAndSave(voting('session-a', 2, { 'user-1': 'en' }), 1)).toBe(true);
    expect(await repository.compareAndSave(voting('session-a', 2, { 'user-2': 'es' }), 1)).toBe(false);
    expect(await repository.compareAndSave(voting('session-x', 3), 2)).toBe(false);
    expect((await repository.findLatestByChannel('rsdemo_es_01'))?.votesByUser).toEqual({ 'user-1': 'en' });
  });

  it('keeps a terminal session as latest until a new session starts', async () => {
    const repository = new InMemoryRouletteRepository();
    const first = voting('session-a', 1);
    await repository.compareAndSave(first, null);
    await repository.compareAndSave(cancelled(first), 1);
    expect(await repository.findActiveByChannel('rsdemo_es_01')).toBeNull();
    expect((await repository.findLatestByChannel('rsdemo_es_01'))?.publicState.status).toBe('cancelled');
    expect(await repository.compareAndSave(voting('session-a', 1), null)).toBe(false);
    expect(await repository.compareAndSave(voting('session-b', 1), null)).toBe(true);
    expect((await repository.findLatestByChannel('rsdemo_es_01'))?.publicState.sessionId).toBe('session-b');
  });

  it('treats a wrong next version as a programming error', async () => {
    const repository = new InMemoryRouletteRepository();
    await expect(repository.compareAndSave(voting('session-a', 2), null)).rejects.toThrow();
    await repository.compareAndSave(voting('session-a', 1), null);
    await expect(repository.compareAndSave(voting('session-a', 3), 1)).rejects.toThrow();
  });

  it('rejects counts that do not match individual votes and votes outside the pool', async () => {
    const repository = new InMemoryRouletteRepository();
    const mismatched = voting('session-a', 1, { 'user-1': 'en' });
    mismatched.publicState.votes = { en: 2 };
    await expect(repository.compareAndSave(mismatched, null)).rejects.toThrow();
    const outsidePool = voting('session-a', 1);
    outsidePool.votesByUser = { 'user-1': 'ja' };
    await expect(repository.compareAndSave(outsidePool, null)).rejects.toThrow();
    expect(await repository.findLatestByChannel('rsdemo_es_01')).toBeNull();
  });

  it('returns copies that cannot change stored state', async () => {
    const repository = new InMemoryRouletteRepository();
    const session = voting('session-a', 1, { 'user-1': 'en' });
    await repository.compareAndSave(session, null);
    session.publicState.votes.en = 99;
    const read = await repository.findLatestByChannel('rsdemo_es_01');
    if (!read) throw new Error('Expected a stored session.');
    read.publicState.votes.en = 42;
    expect((await repository.findLatestByChannel('rsdemo_es_01'))?.publicState.votes).toEqual({ en: 1 });
  });
});

describe('in-memory streamer repository', () => {
  const streamer: Streamer = {
    id: 'rsdemo_es_01', login: 'rsdemo_es_01', displayName: 'Demo ES 01', avatarUrl: null,
    language: 'es', minViewers: 10, maxViewers: 20, acceptsOtherLanguages: true, reputation: 0,
  };

  it('seeds, saves, finds, and lists streamers', async () => {
    const repository = new InMemoryStreamerRepository([streamer]);
    await repository.save({ ...streamer, id: 'rsdemo_en_01', login: 'rsdemo_en_01', language: 'en' });
    expect(await repository.findById('rsdemo_es_01')).toEqual(streamer);
    expect(await repository.findById('rsdemo_missing')).toBeNull();
    expect((await repository.listRegistered()).map((entry) => entry.id)).toEqual(['rsdemo_es_01', 'rsdemo_en_01']);
  });

  it('rejects invalid streamers', async () => {
    const repository = new InMemoryStreamerRepository();
    await expect(repository.save({ ...streamer, minViewers: 30 })).rejects.toThrow();
    expect(() => new InMemoryStreamerRepository([{ ...streamer, login: 'not valid' }])).toThrow();
  });

  it('returns copies that cannot change stored state', async () => {
    const repository = new InMemoryStreamerRepository([streamer]);
    const read = await repository.findById('rsdemo_es_01');
    if (!read) throw new Error('Expected a stored streamer.');
    read.reputation = 99;
    expect((await repository.findById('rsdemo_es_01'))?.reputation).toBe(0);
  });
});
