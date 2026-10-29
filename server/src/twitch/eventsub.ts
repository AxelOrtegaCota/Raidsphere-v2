/**
 * Twitch EventSub — Real-time event subscriptions
 * 
 * Uses WebSocket transport (no need for public webhook endpoint during dev).
 * Listens for raid events and chat messages.
 * 
 * @see https://dev.twitch.tv/docs/eventsub/
 */

import type { LanguageCode } from '@raidsphere/shared';

// ============================================================================
// Types
// ============================================================================

export interface EventSubSubscription {
  id: string;
  type: string;
  version: string;
  status: string;
  condition: Record<string, string>;
  transport: {
    method: 'websocket' | 'webhook';
    session_id?: string;
    callback?: string;
  };
  created_at: string;
}

export interface RaidEvent {
  from_broadcaster_user_id: string;
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  to_broadcaster_user_id: string;
  to_broadcaster_user_login: string;
  to_broadcaster_user_name: string;
  viewers: number;
}

export interface ChannelChatMessageEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  message_id: string;
  message: {
    text: string;
    fragments: Array<{
      type: 'text' | 'cheermote' | 'emote' | 'mention';
      text: string;
      cheermote?: { prefix: string; bits: number };
      emote?: { id: string; emote_set_id: string };
      mention?: { user_id: string; user_login: string; user_name: string };
    }>;
  };
  color: string;
  badges: Array<{ set_id: string; id: string; info: string }>;
}

export interface EventSubMessage {
  metadata: {
    message_id: string;
    message_type: 'session_welcome' | 'session_keepalive' | 'notification' | 'session_reconnect' | 'revocation';
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: {
    session?: {
      id: string;
      status: string;
      connected_at: string;
      keepalive_timeout_seconds: number;
      reconnect_url?: string;
    };
    subscription?: EventSubSubscription;
    event?: RaidEvent | ChannelChatMessageEvent | Record<string, unknown>;
  };
}

export type EventSubEventHandler = (
  type: string,
  event: RaidEvent | ChannelChatMessageEvent | Record<string, unknown>
) => void;

// ============================================================================
// Configuration
// ============================================================================

const EVENTSUB_WSS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_BASE = 'https://api.twitch.tv/helix';

function getClientId(): string {
  const id = process.env['TWITCH_CLIENT_ID'];
  if (!id) throw new Error('TWITCH_CLIENT_ID not configured');
  return id;
}

// ============================================================================
// EventSub WebSocket Client
// ============================================================================

export interface EventSubClientOptions {
  accessToken: string;
  userId: string;
  onEvent: EventSubEventHandler;
  onConnected?: (sessionId: string) => void;
  onDisconnected?: (reason: string) => void;
  onError?: (error: Error) => void;
}

export interface EventSubClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  getSessionId(): string | null;
  subscribeToRaids(): Promise<EventSubSubscription>;
  subscribeToChatMessages(): Promise<EventSubSubscription>;
}

export function createEventSubClient(options: EventSubClientOptions): EventSubClient {
  const { accessToken, userId, onEvent, onConnected, onDisconnected, onError } = options;
  
  let ws: WebSocket | null = null;
  let sessionId: string | null = null;
  let keepaliveTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectUrl: string | null = null;
  
  function clearKeepalive(): void {
    if (keepaliveTimeout) {
      clearTimeout(keepaliveTimeout);
      keepaliveTimeout = null;
    }
  }
  
  function resetKeepalive(timeoutSeconds: number): void {
    clearKeepalive();
    // Add 10% buffer to the timeout
    const bufferMs = (timeoutSeconds * 1000) * 1.1;
    keepaliveTimeout = setTimeout(() => {
      console.warn('[EventSub] Keepalive timeout — reconnecting');
      reconnect();
    }, bufferMs);
  }
  
  function reconnect(): void {
    disconnect();
    setTimeout(() => connect(), 1000);
  }
  
  function handleMessage(data: string): void {
    try {
      const message: EventSubMessage = JSON.parse(data);
      const { metadata, payload } = message;
      
      switch (metadata.message_type) {
        case 'session_welcome':
          if (payload.session) {
            sessionId = payload.session.id;
            resetKeepalive(payload.session.keepalive_timeout_seconds);
            console.info(`[EventSub] Connected with session ${sessionId}`);
            onConnected?.(sessionId);
          }
          break;
          
        case 'session_keepalive':
          // Reset the keepalive timer
          if (payload.session) {
            resetKeepalive(payload.session.keepalive_timeout_seconds);
          }
          break;
          
        case 'session_reconnect':
          if (payload.session?.reconnect_url) {
            reconnectUrl = payload.session.reconnect_url;
            console.info('[EventSub] Reconnect requested');
            reconnect();
          }
          break;
          
        case 'notification':
          if (metadata.subscription_type && payload.event) {
            onEvent(metadata.subscription_type, payload.event);
          }
          break;
          
        case 'revocation':
          console.warn('[EventSub] Subscription revoked:', payload.subscription?.type);
          break;
      }
    } catch (error) {
      console.error('[EventSub] Failed to parse message:', error);
    }
  }
  
  function connect(): void {
    const url = reconnectUrl ?? EVENTSUB_WSS_URL;
    reconnectUrl = null;
    
    try {
      ws = new WebSocket(url);
      
      ws.onopen = () => {
        console.info('[EventSub] WebSocket opened');
      };
      
      ws.onmessage = (event) => {
        handleMessage(String(event.data));
      };
      
      ws.onclose = (event) => {
        clearKeepalive();
        sessionId = null;
        const reason = event.reason || `Code ${event.code}`;
        console.info(`[EventSub] Disconnected: ${reason}`);
        onDisconnected?.(reason);
        
        // Auto-reconnect on abnormal closure
        if (event.code !== 1000) {
          setTimeout(() => connect(), 5000);
        }
      };
      
      ws.onerror = (event) => {
        const error = new Error(`WebSocket error: ${String(event)}`);
        console.error('[EventSub]', error.message);
        onError?.(error);
      };
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  function disconnect(): void {
    clearKeepalive();
    if (ws) {
      ws.close(1000, 'Client disconnect');
      ws = null;
    }
    sessionId = null;
  }
  
  async function createSubscription(
    type: string,
    version: string,
    condition: Record<string, string>
  ): Promise<EventSubSubscription> {
    if (!sessionId) {
      throw new Error('Not connected to EventSub — call connect() first');
    }
    
    const response = await fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': getClientId(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        version,
        condition,
        transport: {
          method: 'websocket',
          session_id: sessionId,
        },
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create subscription: ${response.status} ${error}`);
    }
    
    const result = await response.json() as { data: EventSubSubscription[] };
    const subscription = result.data[0];
    if (!subscription) {
      throw new Error('No subscription returned');
    }
    
    console.info(`[EventSub] Subscribed to ${type}`);
    return subscription;
  }
  
  return {
    connect,
    disconnect,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    getSessionId: () => sessionId,
    
    async subscribeToRaids(): Promise<EventSubSubscription> {
      // channel.raid — fires when a raid starts TO this channel
      return createSubscription('channel.raid', '1', {
        to_broadcaster_user_id: userId,
      });
    },
    
    async subscribeToChatMessages(): Promise<EventSubSubscription> {
      // channel.chat.message — fires for each chat message
      return createSubscription('channel.chat.message', '1', {
        broadcaster_user_id: userId,
        user_id: userId, // Bot user ID (same as broadcaster for self-listen)
      });
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
