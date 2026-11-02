/**
 * Module B: real raids through Helix, using the source channel's own token.
 * A raid moves real viewers, so requests are never replayed, including after a 401.
 * Arrivals come from EventSub, never from this response.
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
const TOKEN_WAIT_MS = 5_000;
const TWITCH_USER_ID = /^[0-9]+$/;

/** Only a client error proves Twitch refused the call; anything else may have started a raid. */
function isDefiniteRefusal(error: unknown): error is HelixError {
  return error instanceof HelixError && error.status >= 400 && error.status < 500;
}

export class RealRaidGateway implements RaidGateway {
  readonly #deps: RealRaidGatewayDependencies;
  readonly #requests = new Map<string, { from: string; to: string; result: Promise<RaidRequestResult> }>();

  constructor(dependencies: RealRaidGatewayDependencies) {
    this.#deps = dependencies;
  }

  requestRaid(request: { sessionId: string; fromChannelId: string; toStreamerId: string }): Promise<RaidRequestResult> {
    const existing = this.#requests.get(request.sessionId);
    if (existing) return existing.from === request.fromChannelId && existing.to === request.toStreamerId
      ? existing.result : Promise.resolve({ outcome: 'rejected' });
    if (this.#requests.size >= TRACKED_SESSIONS) return Promise.resolve({ outcome: 'rejected' });
    const result = this.#start(request.fromChannelId, request.toStreamerId);
    this.#requests.set(request.sessionId, { from: request.fromChannelId, to: request.toStreamerId, result });
    return result;
  }

  async cancelRaid(request: { sessionId: string; fromChannelId: string }): Promise<RaidCancelResult> {
    const tracked = this.#requests.get(request.sessionId);
    if (!tracked || tracked.from !== request.fromChannelId) return 'not_cancelled';
    const started = await tracked.result;
    // A raid the streamer started by hand is not ours to stop.
    if (started?.outcome !== 'accepted') return 'not_cancelled';
    const { cancel = cancelRaid } = this.#deps;
    try {
      await this.#withToken(request.fromChannelId, (config) => cancel(request.fromChannelId, config));
      // Retain the idempotency record after cancellation too.
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
        // The status code alone is safe to log; Twitch's message text is not.
        reportError(`Twitch refused a raid request (HTTP ${error.status}).`);
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      let accessToken: string | null | undefined;
      try {
        accessToken = await Promise.race([
          provider?.({ forceRefresh }).catch(() => null),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new DOMException('Token acquisition timed out.', 'TimeoutError')), TOKEN_WAIT_MS);
          }),
        ]);
      } finally { clearTimeout(timer); }
      if (!accessToken) throw new HelixError('No access token is available.', 401);
      return { accessToken, clientId: clientId() };
    };
    return call(await read(false));
  }
}
