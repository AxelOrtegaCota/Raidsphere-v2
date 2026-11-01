/**
 * Module B: roulette candidates from real channels.
 * Only streamers connected to RaidSphere qualify: their chat is readable, so translation
 * works when a raid arrives, and nobody receives a raid without having joined.
 */
import { COUNTRY_BY_LANGUAGE } from '../application/illustrative-country.js';
import type { CandidateSource, LiveChannel } from '../application/ports.js';
import type { StreamerRepository } from '../persistence/contracts.js';
import { getStreams, type Stream } from './helix.js';
import { getAppAccessToken, loadOAuthConfig } from './oauth.js';

export interface RegisteredCandidateOptions {
  fetchStreams?: (channelIds: readonly string[]) => Promise<readonly Stream[]>;
  timeoutMs?: number;
}

export interface RegisteredCandidateDependencies extends RegisteredCandidateOptions {
  connectedChannels: () => readonly string[];
  streamers: Pick<StreamerRepository, 'findById'>;
  // Receives fixed, content-free messages only.
  reportError: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_STREAMS_PER_REQUEST = 100;

async function fetchLiveStreams(channelIds: readonly string[]): Promise<readonly Stream[]> {
  const config = loadOAuthConfig(process.env);
  const accessToken = await getAppAccessToken(config);
  return getStreams({ accessToken, clientId: config.clientId }, channelIds, MAX_STREAMS_PER_REQUEST);
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('The request timed out.')); }, timeoutMs);
  });
  return Promise.race([task, expired]).finally(() => { clearTimeout(timer); });
}

export class RegisteredCandidateSource implements CandidateSource {
  readonly #deps: RegisteredCandidateDependencies;

  constructor(dependencies: RegisteredCandidateDependencies) {
    this.#deps = dependencies;
  }

  async listLiveChannels(): Promise<readonly LiveChannel[]> {
    const { connectedChannels, fetchStreams = fetchLiveStreams, timeoutMs = DEFAULT_TIMEOUT_MS, reportError } = this.#deps;
    const channelIds = connectedChannels();
    // Get Streams without a user filter would return the top streams on all of Twitch.
    if (channelIds.length === 0) return [];
    try {
      const streams = await withTimeout(fetchStreams(channelIds), timeoutMs);
      const live = streams.filter((stream) => stream.type === 'live' && channelIds.includes(stream.userId));
      const channels = await Promise.all(live.map((stream) => this.#toLiveChannel(stream)));
      return channels.flatMap((channel) => (channel ? [channel] : []));
    } catch {
      reportError('Live channels could not be read from Twitch.');
      return [];
    }
  }

  async #toLiveChannel(stream: Stream): Promise<LiveChannel | null> {
    const streamer = await this.#deps.streamers.findById(stream.userId);
    if (!streamer) return null;
    return {
      streamer, viewers: stream.viewerCount, gameName: stream.gameName, title: stream.title,
      illustrativeCountry: COUNTRY_BY_LANGUAGE[streamer.language],
    };
  }
}
