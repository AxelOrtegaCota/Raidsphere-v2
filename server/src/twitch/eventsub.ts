/**
 * Twitch EventSub — Real-time event subscriptions
 *
 * Uses WebSocket transport (no need for public webhook endpoint during dev).
 * Listens for outgoing raids, and for chat and moderation events per channel.
 * Reports carry no tokens, response bodies, or chat text.
 *
 * @see https://dev.twitch.tv/docs/eventsub/
 */

import type { LanguageCode } from '@raidsphere/shared';
import { WebSocket, type RawData } from 'ws';
import type { z } from 'zod';
import type { Clock, Scheduler, TimerHandle } from '../application/ports.js';
import { systemClock, timerScheduler } from '../application/runtime.js';
import {
  eventSubEnvelopeSchema, notificationSchemas, subscriptionResponseSchema,
  type ChannelChatMessageEvent, type EventSubEnvelope, type RaidEvent,
} from './eventsub-schemas.js';
import type { AccessTokenProvider } from './session-tokens.js';

export type {
  ChannelChatMessageEvent, ChatClearEvent, ChatClearUserEvent, ChatMessageDeleteEvent, EventSubEnvelope, RaidEvent,
} from './eventsub-schemas.js';

// ============================================================================
// Types
// ============================================================================

type NotificationType = keyof typeof notificationSchemas;

export type EventSubNotification = {
  [Type in NotificationType]: {
    /** Twitch message id; identifies the delivery, not the chat message. */
    eventId: string;
    receivedAtMs: number;
    type: Type;
    event: z.infer<(typeof notificationSchemas)[Type]>;
  };
}[NotificationType];

export type EventSubStatus = 'stopped' | 'connecting' | 'connected' | 'reconnecting';

interface SubscriptionSpec {
  type: string;
  condition: Record<string, string>;
}

interface Connection {
  socket: WebSocket;
  sessionId: string | null;
  keepaliveMs: number;
  timer: TimerHandle | null;
}

// ============================================================================
// Configuration
// ============================================================================

const EVENTSUB_WSS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const WELCOME_TIMEOUT_MS = 10_000;
const KEEPALIVE_MARGIN = 1.1;
// Twitch closes the old connection about 30 s after asking the client to move.
const RECONNECT_GRACE_MS = 35_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REMEMBERED_EVENTS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_ATTEMPTS = 3;
const CHAT_SUBSCRIPTION_TYPES = [
  'channel.chat.message',
  'channel.chat.message_delete',
  'channel.chat.clear',
  'channel.chat.clear_user_messages',
] as const;

// ============================================================================
// EventSub WebSocket Client
// ============================================================================

export interface EventSubClientOptions {
  clientId: string;
  /** The authenticated user. WebSocket subscriptions require this user's token. */
  userId: string;
  getAccessToken: AccessTokenProvider;
  onNotification: (notification: EventSubNotification) => void;
  reportError: (message: string) => void;
  onStatus?: (status: EventSubStatus) => void;
  /** Twitch does not recreate a revoked subscription; the caller decides what that means. */
  onRevoked?: (type: string, reason: string) => void;
  url?: string;
  helixBaseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  scheduler?: Scheduler;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  retryBaseMs?: number;
}

export interface EventSubClient {
  start(): void;
  stop(): void;
  status(): EventSubStatus;
  /** Resolves true once chat and moderation events are active; a pending session subscribes on welcome. */
  watchChat(channelId: string): Promise<boolean>;
  unwatchChat(channelId: string): Promise<void>;
}

function chatKey(type: string, channelId: string): string {
  return `${type}:${channelId}`;
}

function isExpectedReconnectUrl(value: string, configuredUrl: string): boolean {
  try {
    const target = new URL(value);
    const configured = new URL(configuredUrl);
    if (target.host === configured.host && target.protocol === configured.protocol) return true;
    return target.protocol === 'wss:' && target.hostname.endsWith('.twitch.tv');
  } catch {
    return false;
  }
}

function parseFrame(data: RawData): EventSubEnvelope | null {
  try {
    const parsed = eventSubEnvelopeSchema.safeParse(JSON.parse(data.toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseNotification(envelope: EventSubEnvelope, receivedAtMs: number): EventSubNotification | null {
  const type = envelope.payload.subscription?.type;
  if (!type || !Object.hasOwn(notificationSchemas, type)) return null;
  const parsed = notificationSchemas[type as NotificationType].safeParse(envelope.payload.event);
  if (!parsed.success) return null;
  return { eventId: envelope.metadata.message_id, receivedAtMs, type, event: parsed.data } as EventSubNotification;
}

export function createEventSubClient(options: EventSubClientOptions): EventSubClient {
  const {
    clientId, userId, getAccessToken, onNotification, reportError, onStatus, onRevoked,
    url = EVENTSUB_WSS_URL, helixBaseUrl = HELIX_BASE, fetch: fetchImpl = fetch,
    clock = systemClock, scheduler = timerScheduler,
    reconnectBaseMs = 1_000, maxReconnectDelayMs = 30_000, retryBaseMs = 500,
  } = options;

  const desired = new Map<string, SubscriptionSpec>([
    ['channel.raid', { type: 'channel.raid', condition: { from_broadcaster_user_id: userId } }],
  ]);
  // Subscription ids for this session. A 409 means active with an unknown id.
  const active = new Map<string, string | null>();
  const inFlight = new Map<string, Promise<boolean>>();
  const seenEvents = new Set<string>();

  let current: Connection | null = null;
  // The connection a session_reconnect is moving to, until its welcome arrives.
  let next: Connection | null = null;
  let status: EventSubStatus = 'stopped';
  let generation = 0;
  let failedConnections = 0;
  let reconnectTimer: TimerHandle | null = null;

  function setStatus(value: EventSubStatus): void {
    if (status === value) return;
    status = value;
    onStatus?.(value);
  }

  function arm(connection: Connection): void {
    connection.timer?.cancel();
    connection.timer = scheduler.schedule(connection.keepaliveMs, () => { connection.socket.terminate(); });
  }

  function release(connection: Connection): void {
    connection.timer?.cancel();
    connection.socket.close(1000);
  }

  function open(target: string): Connection {
    const connection: Connection = {
      socket: new WebSocket(target, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: WELCOME_TIMEOUT_MS }),
      sessionId: null, keepaliveMs: WELCOME_TIMEOUT_MS, timer: null,
    };
    arm(connection);
    connection.socket.on('message', (data) => { handleFrame(connection, data); });
    connection.socket.on('close', (code) => { handleClose(connection, code); });
    // A close always follows, and that is where recovery happens.
    connection.socket.on('error', () => undefined);
    return connection;
  }

  function scheduleReconnect(): void {
    setStatus('reconnecting');
    const delayMs = Math.min(reconnectBaseMs * 2 ** failedConnections, maxReconnectDelayMs);
    failedConnections += 1;
    reconnectTimer = scheduler.schedule(delayMs, () => {
      reconnectTimer = null;
      current = open(url);
    });
  }

  function handleClose(connection: Connection, code: number): void {
    connection.timer?.cancel();
    if (connection === next) next = null;
    else if (connection === current) current = null;
    else return;
    reportError(`EventSub connection closed with code ${code}.`);
    if (!current && !next) scheduleReconnect();
  }

  function handleWelcome(connection: Connection, envelope: EventSubEnvelope): void {
    const session = envelope.payload.session;
    if (!session) {
      reportError('EventSub sent a welcome without a session.');
      return;
    }
    connection.sessionId = session.id;
    if (session.keepalive_timeout_seconds) {
      connection.keepaliveMs = session.keepalive_timeout_seconds * 1000 * KEEPALIVE_MARGIN;
    }
    setStatus('connected');
    if (connection === next) {
      // Twitch moves the subscriptions with the session, so nothing is created again.
      const previous = current;
      current = connection;
      next = null;
      if (previous) release(previous);
      failedConnections = 0;
      return;
    }
    generation += 1;
    active.clear();
    inFlight.clear();
    void Promise.all([...desired.keys()].map(ensure)).then((results) => {
      if (results.every(Boolean)) failedConnections = 0;
    });
  }

  function handleReconnect(connection: Connection, envelope: EventSubEnvelope): void {
    const target = envelope.payload.session?.reconnect_url;
    if (!target || next || connection !== current) return;
    if (!isExpectedReconnectUrl(target, url)) {
      reportError('EventSub sent a reconnect URL outside the expected hosts.');
      return;
    }
    // Keepalives may stop now; events keep flowing here until the new welcome.
    connection.keepaliveMs = RECONNECT_GRACE_MS;
    arm(connection);
    next = open(target);
  }

  function handleRevocation(envelope: EventSubEnvelope): void {
    const subscription = envelope.payload.subscription;
    if (!subscription) return;
    const key = [...active].find(([, id]) => id === subscription.id)?.[0];
    if (key) {
      active.delete(key);
      desired.delete(key);
    }
    reportError(`EventSub revoked ${subscription.type}: ${subscription.status}.`);
    onRevoked?.(subscription.type, subscription.status);
  }

  function handleNotification(envelope: EventSubEnvelope): void {
    const eventId = envelope.metadata.message_id;
    if (seenEvents.has(eventId)) return;
    seenEvents.add(eventId);
    if (seenEvents.size > MAX_REMEMBERED_EVENTS) {
      seenEvents.delete(seenEvents.values().next().value as string);
    }
    const notification = parseNotification(envelope, clock.now());
    if (!notification) {
      reportError('An EventSub notification was dropped because it failed validation.');
      return;
    }
    try {
      onNotification(notification);
    } catch {
      reportError('An EventSub event could not be handled.');
    }
  }

  function handleFrame(connection: Connection, data: RawData): void {
    if (connection !== current && connection !== next) return;
    const envelope = parseFrame(data);
    if (!envelope) {
      reportError('An EventSub message was dropped because it failed validation.');
      return;
    }
    switch (envelope.metadata.message_type) {
      case 'session_welcome':
        handleWelcome(connection, envelope);
        arm(connection);
        break;
      case 'session_keepalive':
        arm(connection);
        break;
      case 'notification':
        arm(connection);
        handleNotification(envelope);
        break;
      case 'session_reconnect':
        handleReconnect(connection, envelope);
        break;
      case 'revocation':
        handleRevocation(envelope);
        break;
    }
  }

  const wait = (delayMs: number): Promise<void> => new Promise((resolve) => {
    scheduler.schedule(delayMs, resolve);
  });

  /** Bounded Helix call: refreshes the token once on 401 and retries transient failures. */
  async function helixRequest(path: string, init: RequestInit, requestGeneration: number): Promise<Response | null> {
    let forceRefresh = false;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      if (requestGeneration !== generation) return null;
      try {
        const accessToken = await getAccessToken({ forceRefresh });
        const response = await fetchImpl(`${helixBaseUrl}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401 && !forceRefresh) {
          forceRefresh = true;
          continue;
        }
        if (response.status !== 429 && response.status < 500) return response;
      } catch {
        // Treated like a transient response: the loop retries, then gives up.
      }
      await wait(retryBaseMs * 2 ** attempt);
    }
    return null;
  }

  async function removeSubscription(id: string, requestGeneration: number): Promise<void> {
    const response = await helixRequest(`/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, requestGeneration);
    if (requestGeneration === generation && !response?.ok) reportError('An EventSub subscription could not be removed.');
  }

  async function subscribe(key: string, spec: SubscriptionSpec, sessionId: string, requestGeneration: number): Promise<boolean> {
    const response = await helixRequest('/eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        type: spec.type, version: '1', condition: spec.condition,
        transport: { method: 'websocket', session_id: sessionId },
      }),
    }, requestGeneration);
    if (requestGeneration !== generation) return false;
    if (!response) {
      reportError(`EventSub could not reach Twitch to subscribe to ${spec.type}.`);
      return false;
    }
    if (response.status === 409) {
      active.set(key, null);
      return true;
    }
    if (!response.ok) {
      reportError(`EventSub rejected ${spec.type} with status ${response.status}.`);
      return false;
    }
    const parsed = subscriptionResponseSchema.safeParse(await response.json().catch(() => null));
    const id = parsed.success ? parsed.data.data[0]?.id : undefined;
    if (!id) {
      reportError(`EventSub returned an invalid response for ${spec.type}.`);
      return false;
    }
    if (!desired.has(key)) {
      await removeSubscription(id, requestGeneration);
      return false;
    }
    active.set(key, id);
    return true;
  }

  function ensure(key: string): Promise<boolean> {
    if (active.has(key)) return Promise.resolve(true);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const spec = desired.get(key);
    const sessionId = current?.sessionId;
    if (!spec || !sessionId) return Promise.resolve(false);
    const task: Promise<boolean> = subscribe(key, spec, sessionId, generation).finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }

  return {
    start(): void {
      if (status !== 'stopped') return;
      setStatus('connecting');
      current = open(url);
    },

    stop(): void {
      generation += 1;
      reconnectTimer?.cancel();
      reconnectTimer = null;
      const connections = [current, next];
      current = null;
      next = null;
      active.clear();
      inFlight.clear();
      for (const connection of connections) if (connection) release(connection);
      setStatus('stopped');
    },

    status: () => status,

    async watchChat(channelId: string): Promise<boolean> {
      const keys = CHAT_SUBSCRIPTION_TYPES.map((type) => {
        const key = chatKey(type, channelId);
        desired.set(key, { type, condition: { broadcaster_user_id: channelId, user_id: userId } });
        return key;
      });
      const results = await Promise.all(keys.map(ensure));
      return results.every(Boolean);
    },

    async unwatchChat(channelId: string): Promise<void> {
      const requestGeneration = generation;
      const removals = CHAT_SUBSCRIPTION_TYPES.map((type) => {
        const key = chatKey(type, channelId);
        const id = active.get(key);
        desired.delete(key);
        active.delete(key);
        return id ? removeSubscription(id, requestGeneration) : Promise.resolve();
      });
      await Promise.all(removals);
    },
  };
}

// ============================================================================
// Raid Detection Helper
// ============================================================================

export interface DetectedRaid {
  fromChannelId: string;
  fromChannelName: string;
  toChannelId: string;
  toChannelName: string;
  viewers: number;
  timestamp: number;
}

export function parseRaidEvent(event: RaidEvent): DetectedRaid {
  return {
    fromChannelId: event.from_broadcaster_user_id,
    fromChannelName: event.from_broadcaster_user_name,
    toChannelId: event.to_broadcaster_user_id,
    toChannelName: event.to_broadcaster_user_name,
    viewers: event.viewers,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Chat Command Detection
// ============================================================================

export interface DetectedCommand {
  command: 'roulette' | 'vote' | 'cancel' | null;
  language?: LanguageCode;
  userId: string;
  userName: string;
  messageId: string;
  isBroadcaster: boolean;
  isModerator: boolean;
}

export function parseChatCommand(event: ChannelChatMessageEvent): DetectedCommand | null {
  const text = event.message.text.trim();

  // Check for roulette commands
  const rouletteMatch = /^!(roulette|ruleta|ルーレット|룰렛)$/i.exec(text);
  if (rouletteMatch) {
    return {
      command: 'roulette',
      userId: event.chatter_user_id,
      userName: event.chatter_user_name,
      messageId: event.message_id,
      isBroadcaster: event.badges.some(b => b.set_id === 'broadcaster'),
      isModerator: event.badges.some(b => b.set_id === 'moderator'),
    };
  }

  // Check for vote commands
  const voteMatch = /^!(vote|votar|v)\s+(\w+)$/i.exec(text);
  if (voteMatch) {
    const langInput = voteMatch[2]?.toLowerCase();
    const languageMap: Record<string, LanguageCode> = {
      'en': 'en', 'english': 'en', 'inglés': 'en', 'ingles': 'en',
      'es': 'es', 'spanish': 'es', 'español': 'es', 'espanol': 'es',
      'pt': 'pt', 'portuguese': 'pt', 'portugués': 'pt', 'portugues': 'pt',
      'fr': 'fr', 'french': 'fr', 'francés': 'fr', 'frances': 'fr',
      'de': 'de', 'german': 'de', 'alemán': 'de', 'aleman': 'de',
      'ja': 'ja', 'japanese': 'ja', 'japonés': 'ja', 'japones': 'ja',
      'ko': 'ko', 'korean': 'ko', 'coreano': 'ko',
    };
    const language = langInput ? languageMap[langInput] : undefined;

    if (language) {
      return {
        command: 'vote',
        language,
        userId: event.chatter_user_id,
        userName: event.chatter_user_name,
        messageId: event.message_id,
        isBroadcaster: event.badges.some(b => b.set_id === 'broadcaster'),
        isModerator: event.badges.some(b => b.set_id === 'moderator'),
      };
    }
  }

  // Check for cancel commands
  const cancelMatch = /^!(cancel|cancelar|キャンセル|취소)$/i.exec(text);
  if (cancelMatch) {
    return {
      command: 'cancel',
      userId: event.chatter_user_id,
      userName: event.chatter_user_name,
      messageId: event.message_id,
      isBroadcaster: event.badges.some(b => b.set_id === 'broadcaster'),
      isModerator: event.badges.some(b => b.set_id === 'moderator'),
    };
  }

  return null;
}
