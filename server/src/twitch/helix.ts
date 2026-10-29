/**
 * Module B: Twitch Helix API client
 * 
 * Provides typed access to Twitch Helix API endpoints for channel search,
 * stream information, and raid operations. All functions require an access
 * token and handle rate limits and API errors appropriately.
 */
import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

const HELIX_BASE_URL = 'https://api.twitch.tv/helix';

// Rate limit retry configuration
const MAX_RETRIES = 3;
const RATE_LIMIT_STATUS = 429;

// ============================================================================
// Types
// ============================================================================

/**
 * Twitch channel information from search or channel info endpoints.
 */
export interface Channel {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly broadcasterLanguage: string;
  readonly gameId: string;
  readonly gameName: string;
  readonly title: string;
  readonly isLive: boolean;
  readonly thumbnailUrl: string;
  readonly tags: readonly string[];
}

/**
 * Twitch stream information for live channels.
 */
export interface Stream {
  readonly id: string;
  readonly userId: string;
  readonly userLogin: string;
  readonly userName: string;
  readonly gameId: string;
  readonly gameName: string;
  readonly type: 'live' | '';
  readonly title: string;
  readonly viewerCount: number;
  readonly startedAt: string;
  readonly language: string;
  readonly thumbnailUrl: string;
  readonly tags: readonly string[];
  readonly isMature: boolean;
}

/**
 * Response from the Twitch raid API.
 */
export interface RaidResponse {
  readonly createdAt: string;
  readonly isMature: boolean;
}

/**
 * Helix API error structure.
 */
export interface HelixApiError {
  readonly status: number;
  readonly message: string;
  readonly error?: string;
}

/**
 * Configuration for API requests.
 */
export interface HelixRequestConfig {
  readonly accessToken: string;
  readonly clientId: string;
}

// ============================================================================
// Zod Schemas for API Response Validation
// ============================================================================

const channelDataSchema = z.object({
  id: z.string(),
  broadcaster_login: z.string(),
  display_name: z.string(),
  broadcaster_language: z.string(),
  game_id: z.string(),
  game_name: z.string(),
  title: z.string(),
  is_live: z.boolean(),
  thumbnail_url: z.string(),
  tags: z.array(z.string()).optional().default([]),
});

const searchChannelsResponseSchema = z.object({
  data: z.array(channelDataSchema),
  pagination: z.object({
    cursor: z.string().optional(),
  }).optional(),
});

const channelInfoDataSchema = z.object({
  broadcaster_id: z.string(),
  broadcaster_login: z.string(),
  broadcaster_name: z.string(),
  broadcaster_language: z.string(),
  game_id: z.string(),
  game_name: z.string(),
  title: z.string(),
  delay: z.number(),
  tags: z.array(z.string()).optional().default([]),
  content_classification_labels: z.array(z.string()).optional().default([]),
  is_branded_content: z.boolean().optional(),
});

const getChannelInfoResponseSchema = z.object({
  data: z.array(channelInfoDataSchema),
});

const streamDataSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
  game_id: z.string(),
  game_name: z.string(),
  type: z.enum(['live', '']),
  title: z.string(),
  viewer_count: z.number(),
  started_at: z.string(),
  language: z.string(),
  thumbnail_url: z.string(),
  tags: z.array(z.string()).nullable().optional().default([]),
  is_mature: z.boolean(),
});

const getStreamsResponseSchema = z.object({
  data: z.array(streamDataSchema),
  pagination: z.object({
    cursor: z.string().optional(),
  }).optional(),
});

const raidDataSchema = z.object({
  created_at: z.string(),
  is_mature: z.boolean(),
});

const startRaidResponseSchema = z.object({
  data: z.array(raidDataSchema),
});

// ============================================================================
// Error Handling
// ============================================================================

export class HelixError extends Error {
  readonly status: number;
  readonly apiError?: string;

  constructor(message: string, status: number, apiError?: string) {
    super(message);
    this.name = 'HelixError';
    this.status = status;
    this.apiError = apiError;
    Object.setPrototypeOf(this, HelixError.prototype);
  }
}

export class RateLimitError extends HelixError {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message, RATE_LIMIT_STATUS);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function buildHeaders(config: HelixRequestConfig): Record<string, string> {
  return {
    'Authorization': `Bearer ${config.accessToken}`,
    'Client-Id': config.clientId,
    'Content-Type': 'application/json',
  };
}

async function parseErrorResponse(response: Response): Promise<HelixApiError> {
  try {
    const body = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      message: typeof body.message === 'string' ? body.message : response.statusText,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
  } catch {
    return {
      status: response.status,
      message: response.statusText,
    };
  }
}

function extractRetryAfterMs(response: Response): number {
  const retryAfter = response.headers.get('Ratelimit-Reset');
  if (retryAfter) {
    const resetTimestamp = parseInt(retryAfter, 10) * 1000;
    const now = Date.now();
    return Math.max(resetTimestamp - now, 1000);
  }
  // Default to 1 second if no header present
  return 1000;
}

async function helixFetch<T>(
  url: string,
  config: HelixRequestConfig,
  options: RequestInit = {},
  schema: z.ZodType<T>
): Promise<T> {
  const headers = buildHeaders(config);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers as Record<string, string> | undefined },
    });

    if (response.status === RATE_LIMIT_STATUS) {
      const retryAfterMs = extractRetryAfterMs(response);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(retryAfterMs);
        continue;
      }
      throw new RateLimitError(
        `Rate limited by Twitch API. Retry after ${retryAfterMs}ms`,
        retryAfterMs
      );
    }

    if (!response.ok) {
      const errorInfo = await parseErrorResponse(response);
      throw new HelixError(errorInfo.message, errorInfo.status, errorInfo.error);
    }

    // Handle 204 No Content (used by DELETE /raids)
    if (response.status === 204) {
      // For void responses, return empty object that schema should handle
      return schema.parse({});
    }

    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new HelixError(
        `Invalid API response: ${parsed.error.message}`,
        response.status
      );
    }
    return parsed.data;
  }

  throw lastError ?? new HelixError('Max retries exceeded', 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Search for channels by name or game. Returns channels matching the query.
 * 
 * @param query - Search query (channel name, game name, etc.)
 * @param config - Request configuration with access token and client ID
 * @param language - Optional language filter (ISO 639-1 code)
 * @param first - Number of results to return (1-100, default 20)
 * @returns Array of matching channels
 * 
 * @see https://dev.twitch.tv/docs/api/reference/#search-channels
 */
export async function searchChannels(
  query: string,
  config: HelixRequestConfig,
  language?: string,
  first: number = 20
): Promise<readonly Channel[]> {
  const params = new URLSearchParams({
    query,
    first: Math.min(Math.max(first, 1), 100).toString(),
  });

  if (language) {
    params.set('live_only', 'true');
  }

  const url = `${HELIX_BASE_URL}/search/channels?${params.toString()}`;
  const response = await helixFetch(url, config, { method: 'GET' }, searchChannelsResponseSchema);

  let channels = response.data.map(mapChannelData);

  // Filter by language if specified (API doesn't have native language filter for search)
  if (language) {
    channels = channels.filter(ch => 
      ch.broadcasterLanguage.toLowerCase() === language.toLowerCase()
    );
  }

  return Object.freeze(channels);
}

/**
 * Get detailed information about a specific channel.
 * 
 * @param broadcasterId - The broadcaster's user ID
 * @param config - Request configuration with access token and client ID
 * @returns Channel information or null if not found
 * 
 * @see https://dev.twitch.tv/docs/api/reference/#get-channel-information
 */
export async function getChannelInfo(
  broadcasterId: string,
  config: HelixRequestConfig
): Promise<Channel | null> {
  const params = new URLSearchParams({ broadcaster_id: broadcasterId });
  const url = `${HELIX_BASE_URL}/channels?${params.toString()}`;
  
  const response = await helixFetch(url, config, { method: 'GET' }, getChannelInfoResponseSchema);
  
  const data = response.data[0];
  if (!data) {
    return null;
  }

  return Object.freeze({
    id: data.broadcaster_id,
    login: data.broadcaster_login,
    displayName: data.broadcaster_name,
    broadcasterLanguage: data.broadcaster_language,
    gameId: data.game_id,
    gameName: data.game_name,
    title: data.title,
    isLive: false, // Channel info endpoint doesn't include live status
    thumbnailUrl: '',
    tags: Object.freeze(data.tags),
  });
}

/**
 * Start a raid from one channel to another.
 * 
 * @param fromBroadcasterId - The ID of the broadcaster initiating the raid
 * @param toBroadcasterId - The ID of the broadcaster to raid
 * @param config - Request configuration with access token and client ID
 * @returns Raid response with creation time and maturity flag
 * 
 * @see https://dev.twitch.tv/docs/api/reference/#start-a-raid
 */
export async function startRaid(
  fromBroadcasterId: string,
  toBroadcasterId: string,
  config: HelixRequestConfig
): Promise<RaidResponse> {
  const params = new URLSearchParams({
    from_broadcaster_id: fromBroadcasterId,
    to_broadcaster_id: toBroadcasterId,
  });
  const url = `${HELIX_BASE_URL}/raids?${params.toString()}`;
  
  const response = await helixFetch(url, config, { method: 'POST' }, startRaidResponseSchema);
  
  const data = response.data[0];
  if (!data) {
    throw new HelixError('No raid data returned from API', 500);
  }

  return Object.freeze({
    createdAt: data.created_at,
    isMature: data.is_mature,
  });
}

/**
 * Cancel a pending raid.
 * 
 * @param broadcasterId - The ID of the broadcaster who initiated the raid
 * @param config - Request configuration with access token and client ID
 * 
 * @see https://dev.twitch.tv/docs/api/reference/#cancel-a-raid
 */
export async function cancelRaid(
  broadcasterId: string,
  config: HelixRequestConfig
): Promise<void> {
  const params = new URLSearchParams({ broadcaster_id: broadcasterId });
  const url = `${HELIX_BASE_URL}/raids?${params.toString()}`;
  
  // DELETE /raids returns 204 No Content on success
  const emptyResponseSchema = z.object({}).passthrough();
  await helixFetch(url, config, { method: 'DELETE' }, emptyResponseSchema);
}

/**
 * Get information about active streams.
 * 
 * @param config - Request configuration with access token and client ID
 * @param userIds - Optional array of user IDs to filter streams (max 100)
 * @param first - Number of results to return (1-100, default 20)
 * @returns Array of active streams
 * 
 * @see https://dev.twitch.tv/docs/api/reference/#get-streams
 */
export async function getStreams(
  config: HelixRequestConfig,
  userIds?: readonly string[],
  first: number = 20
): Promise<readonly Stream[]> {
  const params = new URLSearchParams({
    first: Math.min(Math.max(first, 1), 100).toString(),
  });

  if (userIds && userIds.length > 0) {
    // Limit to 100 user IDs per API constraint
    const limitedIds = userIds.slice(0, 100);
    for (const id of limitedIds) {
      params.append('user_id', id);
    }
  }

  const url = `${HELIX_BASE_URL}/streams?${params.toString()}`;
  const response = await helixFetch(url, config, { method: 'GET' }, getStreamsResponseSchema);

  const streams = response.data.map(mapStreamData);
  return Object.freeze(streams);
}

// ============================================================================
// Data Mappers
// ============================================================================

function mapChannelData(data: z.infer<typeof channelDataSchema>): Channel {
  return Object.freeze({
    id: data.id,
    login: data.broadcaster_login,
    displayName: data.display_name,
    broadcasterLanguage: data.broadcaster_language,
    gameId: data.game_id,
    gameName: data.game_name,
    title: data.title,
    isLive: data.is_live,
    thumbnailUrl: data.thumbnail_url,
    tags: Object.freeze(data.tags),
  });
}

function mapStreamData(data: z.infer<typeof streamDataSchema>): Stream {
  return Object.freeze({
    id: data.id,
    userId: data.user_id,
    userLogin: data.user_login,
    userName: data.user_name,
    gameId: data.game_id,
    gameName: data.game_name,
    type: data.type,
    title: data.title,
    viewerCount: data.viewer_count,
    startedAt: data.started_at,
    language: data.language,
    thumbnailUrl: data.thumbnail_url,
    tags: Object.freeze(data.tags ?? []),
    isMature: data.is_mature,
  });
}
