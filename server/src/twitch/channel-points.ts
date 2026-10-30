/**
 * Module B: Twitch Channel Points adapter for the flag competition system.
 * 
 * Channel Points are configured by streamers in their Twitch dashboard.
 * We listen for redemptions via EventSub and forward them to the FlagManager.
 * 
 * EventSub subscription type: channel.channel_points_custom_reward_redemption.add
 * Required scope: channel:read:redemptions or channel:manage:redemptions
 */

import type { EventPublisher } from '../application/publisher.js';

/** Configuration for the Channel Points reward that triggers flag contributions */
export interface ChannelPointsRewardConfig {
  /** The custom reward ID created by the streamer for flag contributions */
  rewardId: string;
  /** Points per redemption (the reward cost set by the streamer) */
  pointsPerRedemption: number;
}

/** Raw EventSub payload for channel point redemptions */
export interface ChannelPointRedemptionEvent {
  id: string;
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: 'unfulfilled' | 'fulfilled' | 'canceled';
  reward: {
    id: string;
    title: string;
    cost: number;
    prompt: string;
  };
  redeemed_at: string;
}

/** Parsed contribution from a channel point redemption */
export interface PointContribution {
  eventId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  points: number;
  /** Country code parsed from user_input (streamer's selected country) */
  countryCode: string | null;
  redeemedAt: number;
}

/**
 * Parse the country code from the user input of a channel point redemption.
 * The streamer sets up the reward to ask for a country, and viewers type it.
 * We accept ISO 3166-1 alpha-2 codes (e.g., "US", "MX", "JP").
 */
export function parseCountryFromInput(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  // Accept 2-letter country codes only
  if (/^[A-Z]{2}$/.test(trimmed)) {
    return trimmed;
  }
  // Try to extract from common patterns like "Country: US" or "🇺🇸 US"
  const match = trimmed.match(/\b([A-Z]{2})\b/);
  return match?.[1] ?? null;
}

/**
 * Convert an EventSub redemption event to a point contribution.
 * Returns null if the redemption doesn't match our reward or is invalid.
 */
export function toPointContribution(
  event: ChannelPointRedemptionEvent,
  config: ChannelPointsRewardConfig,
): PointContribution | null {
  // Only process redemptions for our specific reward
  if (event.reward.id !== config.rewardId) return null;
  // Skip canceled redemptions
  if (event.status === 'canceled') return null;

  const countryCode = parseCountryFromInput(event.user_input);
  
  return {
    eventId: event.id,
    channelId: event.broadcaster_user_id,
    userId: event.user_id,
    userDisplayName: event.user_name,
    points: config.pointsPerRedemption,
    countryCode,
    redeemedAt: new Date(event.redeemed_at).getTime(),
  };
}

/** Dependencies for the Channel Points handler */
export interface ChannelPointsHandlerDeps {
  publisher: EventPublisher;
  /** Callback when a valid contribution is received */
  onContribution: (contribution: PointContribution) => Promise<void>;
}

/**
 * Handler for incoming EventSub channel point redemption events.
 * Validates and forwards contributions to the FlagManager.
 */
export class ChannelPointsHandler {
  readonly #deps: ChannelPointsHandlerDeps;
  readonly #configs = new Map<string, ChannelPointsRewardConfig>();
  readonly #seen = new Set<string>();
  readonly #seenLimit = 1_000;

  constructor(deps: ChannelPointsHandlerDeps) {
    this.#deps = deps;
  }

  /**
   * Register a channel's reward configuration.
   * Call this when a streamer enables flag competition on their channel.
   */
  registerChannel(channelId: string, config: ChannelPointsRewardConfig): void {
    this.#configs.set(channelId, config);
  }

  /** Unregister a channel when they disable flag competition */
  unregisterChannel(channelId: string): void {
    this.#configs.delete(channelId);
  }

  /**
   * Handle an incoming EventSub redemption event.
   * Called by the EventSub webhook handler.
   */
  async handleRedemption(event: ChannelPointRedemptionEvent): Promise<void> {
    // Dedupe
    if (this.#seen.has(event.id)) return;
    this.#remember(event.id);

    const config = this.#configs.get(event.broadcaster_user_id);
    if (!config) return;

    const contribution = toPointContribution(event, config);
    if (!contribution) return;

    // If no country was specified, we can't process it
    if (!contribution.countryCode) {
      // Optionally: could publish an error event to notify the user
      return;
    }

    await this.#deps.onContribution(contribution);
  }

  #remember(id: string): void {
    this.#seen.add(id);
    if (this.#seen.size > this.#seenLimit) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }
}

/**
 * Create an EventSub subscription for channel point redemptions.
 * This would be called when setting up the webhook.
 * 
 * Note: This is the subscription request shape, not the actual API call.
 */
export function createRedemptionSubscription(broadcasterId: string) {
  return {
    type: 'channel.channel_points_custom_reward_redemption.add',
    version: '1',
    condition: {
      broadcaster_user_id: broadcasterId,
    },
    transport: {
      method: 'webhook',
      // callback and secret are set by the webhook setup
    },
  };
}
