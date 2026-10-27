import type {
  LanguageCode, PublicRouletteState, RaidLog, Streamer, TranslationWindow,
} from '@raidsphere/shared';

// Server-only persistence boundaries. No driver, configuration, or database I/O.
export interface StoredRouletteSession {
  version: number;
  publicState: PublicRouletteState;
  votesByUser: Readonly<Record<string, LanguageCode>>;
}

export interface StreamerRepository {
  findById(id: string): Promise<Streamer | null>;
  listRegistered(): Promise<readonly Streamer[]>;
  save(streamer: Streamer): Promise<void>;
}

export interface RouletteRepository {
  findActiveByChannel(channelId: string): Promise<StoredRouletteSession | null>;
  // Implementations must atomically enforce the expected version and one active session.
  compareAndSave(session: StoredRouletteSession, expectedVersion: number | null): Promise<boolean>;
}

export interface TranslationWindowRepository {
  findByChannel(channelId: string): Promise<TranslationWindow | null>;
  save(window: TranslationWindow): Promise<void>;
}

export interface RaidRepository {
  // A future adapter must atomically record arrival and credit reputation once per session.
  recordArrivalAndCreditOnce(raid: RaidLog): Promise<'recorded' | 'duplicate'>;
}
