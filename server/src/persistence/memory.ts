import { z } from 'zod';
import {
  identifierSchema, languageCodeSchema, publicRouletteStateSchema, streamerSchema, translationWindowSchema,
} from '@raidsphere/shared';
import type { LanguageCode, RouletteStatus, Streamer, TranslationWindow } from '@raidsphere/shared';
import type {
  RouletteRepository, StoredRouletteSession, StreamerRepository, TranslationWindowRepository,
} from './contracts.js';

// Process-memory repositories for Phase 2 (D2-12). No files, databases, or other persistence I/O.
// Records are validated on write and on read; Zod parsing also returns fresh copies,
// so callers can never mutate stored state through a returned object.

const ACTIVE_STATUSES: ReadonlySet<RouletteStatus> = new Set(['voting', 'selecting', 'chosen', 'raid_pending']);

const storedSessionSchema = z.object({
  version: z.number().int().positive().safe(),
  publicState: publicRouletteStateSchema,
  votesByUser: z.record(identifierSchema, languageCodeSchema),
}).strict().superRefine((value, context) => {
  const poolLanguages = new Set<string>(value.publicState.candidates.map((candidate) => candidate.language));
  const tally = new Map<LanguageCode, number>();
  for (const [userId, language] of Object.entries(value.votesByUser)) {
    if (!poolLanguages.has(language)) {
      context.addIssue({ code: 'custom', path: ['votesByUser', userId], message: 'Votes must use a pool language.' });
    }
    tally.set(language, (tally.get(language) ?? 0) + 1);
  }
  for (const language of languageCodeSchema.options) {
    if ((tally.get(language) ?? 0) !== (value.publicState.votes[language] ?? 0)) {
      context.addIssue({
        code: 'custom', path: ['publicState', 'votes', language], message: 'Public counts must match individual votes.',
      });
    }
  }
});

export class InMemoryStreamerRepository implements StreamerRepository {
  readonly #streamers = new Map<string, Streamer>();

  constructor(initial: readonly Streamer[] = []) {
    for (const streamer of initial) this.#store(streamer);
  }

  async findById(id: string): Promise<Streamer | null> {
    const stored = this.#streamers.get(id);
    return stored ? streamerSchema.parse(stored) : null;
  }

  async listRegistered(): Promise<readonly Streamer[]> {
    return [...this.#streamers.values()].map((streamer) => streamerSchema.parse(streamer));
  }

  async save(streamer: Streamer): Promise<void> {
    this.#store(streamer);
  }

  #store(streamer: Streamer): void {
    const valid = streamerSchema.parse(streamer);
    this.#streamers.set(valid.id, valid);
  }
}

// Keeps only the latest session per channel; no history is retained (D2-17).
export class InMemoryRouletteRepository implements RouletteRepository {
  readonly #latestByChannel = new Map<string, StoredRouletteSession>();

  async findActiveByChannel(channelId: string): Promise<StoredRouletteSession | null> {
    const latest = await this.findLatestByChannel(channelId);
    return latest && ACTIVE_STATUSES.has(latest.publicState.status) ? latest : null;
  }

  async findLatestByChannel(channelId: string): Promise<StoredRouletteSession | null> {
    const stored = this.#latestByChannel.get(channelId);
    return stored ? storedSessionSchema.parse(stored) : null;
  }

  async compareAndSave(session: StoredRouletteSession, expectedVersion: number | null): Promise<boolean> {
    // A wrong next version is a programming error, not a concurrency conflict.
    if (session.version !== (expectedVersion ?? 0) + 1) {
      throw new Error('A saved session must advance its version by exactly one.');
    }
    const next = storedSessionSchema.parse(session);
    const channelId = next.publicState.fromStreamerId;
    const current = this.#latestByChannel.get(channelId);
    if (expectedVersion === null) {
      if (current && (ACTIVE_STATUSES.has(current.publicState.status) ||
          current.publicState.sessionId === next.publicState.sessionId)) return false;
    } else if (!current || current.publicState.sessionId !== next.publicState.sessionId ||
        current.version !== expectedVersion) {
      return false;
    }
    this.#latestByChannel.set(channelId, next);
    return true;
  }
}

// Keeps only the latest window per channel (Phase 4, module 3).
export class InMemoryTranslationWindowRepository implements TranslationWindowRepository {
  readonly #byChannel = new Map<string, TranslationWindow>();

  async findByChannel(channelId: string): Promise<TranslationWindow | null> {
    const stored = this.#byChannel.get(channelId);
    return stored ? translationWindowSchema.parse(stored) : null;
  }

  async save(window: TranslationWindow): Promise<void> {
    const valid = translationWindowSchema.parse(window);
    this.#byChannel.set(valid.channelId, valid);
  }
}
