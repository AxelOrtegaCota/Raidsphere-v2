/**
 * Module B: real raids through Helix, using the source channel's own token.
 * A raid moves real viewers, so nothing here is retried except after a 401, which proves
 * the request never started. Arrivals come from EventSub, never from this response.
 */
import type { Clock, RaidCancelResult, RaidGateway, RaidRequestResult } from '../application/ports.js';
import { systemClock } from '../application/runtime.js';
import { cancelRaid, HelixError, startRaid, type HelixRequestConfig } from './helix.js';
import { loadOAuthConfig } from './oauth.js';
import type { AccessTokenProvider } from './session-tokens.js';

export interface RealRaidOptions {
  start?: (fromChannelId: string, toChannelId: string, config: HelixRequestConfig) => Promise<unknown>;
  cancel?: (fromChannelId: string, config: HelixRequestConfig) => Promise<unknown>;
}

export interface RealRaidGatewayDependencies extends RealRaidOptions {
  tokenProvider: (channelId: string) => AccessTokenProvider | null;
  clientId?: () => string;
  clock?: Clock;
  // Receives fixed, content-free messages only.
  reportError: (message: string) => void;
}

// Twitch holds a raid for up to 90 seconds before it goes out.
const RAID_COUNTDOWN_SECONDS = 90;
const TRACKED_SESSIONS = 1_000;
const TWITCH_USER_ID = /^[0-9]+$/;

/** Only a client error proves Twitch refused the call; anything else may have started a raid. */
function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof HelixError && error.status >= 400 && error.status < 500;
}

export class RealRaidGateway implements RaidGateway {
  readonly #deps: RealRaidGatewayDependencies;
  readonly #requests = new Map<string, Promise<RaidRequestResult>>();

  constructor(dependencies: RealRaidGatewayDependencies) {
    this.#deps = dependencies;
  }

  requestRaid(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult> {
    const existing = this.#requests.get(request.sessionId);
    if (existing) return existing;
    const result = this.#start(request.fromChannelId, request.toStreamerId);
    this.#requests.set(request.sessionId, result);
    if (this.#requests.size > TRACKED_SESSIONS) {
      const oldest = this.#requests.keys().next().value;
      if (oldest !== undefined) this.#requests.delete(oldest);
    }
    return result;
  }

  async cancelRaid(request: { sessionId: string; fromChannelId: string }): Promise<RaidCancelResult> {
    const started = await this.#requests.get(request.sessionId);
    // A raid the streamer started by hand is not ours to stop.
    if (started?.outcome !== 'accepted') return 'not_cancelled';
    const { cancel = cancelRaid } = this.#deps;
    try {
      await this.#withToken(request.fromChannelId, (config) => cancel(request.fromChannelId, config));
      this.#requests.delete(request.sessionId);
      return 'cancelled';
    } catch (error) {
      if (isDefiniteRefusal(error)) return 'not_cancelled';
      this.#deps.reportError('A raid cancellation had no clear answer from Twitch.');
      return 'unknown';
    }
  }

  async #start(fromChannelId: string, toChannelId: string): Promise<RaidRequestResult> {
    const { start = startRaid, clock = systemClock, reportError } = this.#deps;
    if (!TWITCH_USER_ID.test(fromChannelId) || !TWITCH_USER_ID.test(toChannelId)) {
      reportError('A raid was refused because a channel is not a Twitch channel.');
      return { outcome: 'rejected' };
    }
    try {
      await this.#withToken(fromChannelId, (config) => start(fromChannelId, toChannelId, config));
      return { outcome: 'accepted', requestedAtMs: clock.now(), estimatedCountdownSeconds: RAID_COUNTDOWN_SECONDS };
    } catch (error) {
      if (isDefiniteRefusal(error)) {
        reportError('Twitch refused a raid request.');
        return { outcome: 'rejected' };
      }
      reportError('A raid request had no clear answer from Twitch.');
      return { outcome: 'unknown' };
    }
  }

  // A missing token surfaces as a 401, since the request was never sent.
  async #withToken<T>(channelId: string, call: (config: HelixRequestConfig) => Promise<T>): Promise<T> {
    const { tokenProvider, clientId = () => loadOAuthConfig(process.env).clientId } = this.#deps;
    const provider = tokenProvider(channelId);
    const read = async (forceRefresh: boolean): Promise<HelixRequestConfig> => {
      const accessToken = await provider?.({ forceRefresh }).catch(() => null);
      if (!accessToken) throw new HelixError('No access token is available.', 401);
      return { accessToken, clientId: clientId() };
    };
    const config = await read(false);
    try {
      return await call(config);
    } catch (error) {
      if (!(error instanceof HelixError) || error.status !== 401) throw error;
      return call(await read(true));
    }
  }
}
