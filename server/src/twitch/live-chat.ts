/**
 * Module B: one EventSub connection per logged-in channel.
 * Each streamer reads their own chat with their own token, and a raid's destination
 * is a logged-in streamer too, so no channel ever reads another channel's chat.
 */
import { languageCodeSchema } from '@raidsphere/shared';
import type { LanguageCode, Streamer } from '@raidsphere/shared';
import type { ChatCommand, ChatModerationAction, ChatTextMessage, RaidArrival } from '../application/ports.js';
import type { StreamerRepository } from '../persistence/contracts.js';
import { toChatCommand, toChatTextMessage } from './adapters.js';
import {
  isFromAnotherChannel, toChatFragments, toChatMessage, toModerationAction, toRaidArrival,
} from './eventsub-adapters.js';
import {
  createEventSubClient, type ChannelChatMessageEvent, type EventSubClient, type EventSubClientOptions, type EventSubNotification,
} from './eventsub.js';
import { getChannelInfo } from './helix.js';
import { hasRequiredScopes, loadOAuthConfig } from './oauth.js';
import { createSessionTokenProvider, type AccessTokenProvider } from './session-tokens.js';
import type { UserSession } from './sessions.js';

export type LiveChatState = 'offline' | 'connecting' | 'ready';

export interface LiveChatOptions {
  createClient?: (options: EventSubClientOptions) => EventSubClient;
  channelLanguage?: (session: UserSession) => Promise<string | null>;
  maxConnections?: number;
}

export interface LiveChatDependencies extends LiveChatOptions {
  streamers: StreamerRepository;
  commands: {
    handleCommand(command: ChatCommand): Promise<void>;
    handleArrival(arrival: RaidArrival): Promise<void>;
  };
  chat: {
    handleMessage(message: ChatTextMessage): Promise<void>;
    handleModeration(action: ChatModerationAction): Promise<void>;
  };
  // Receives fixed, content-free messages only.
  reportError: (message: string) => void;
}

const DEFAULT_MAX_CONNECTIONS = 25;
// Twitch reports languages the roulette does not support, such as "other".
const DEFAULT_LANGUAGE: LanguageCode = 'en';
// Until streamers can set preferences, a new channel filters nothing out.
const OPEN_MAX_VIEWERS = 1_000_000;

async function readChannelLanguage(session: UserSession): Promise<string | null> {
  const { clientId } = loadOAuthConfig(process.env);
  const channel = await getChannelInfo(session.user.id, { accessToken: session.tokens.access_token, clientId });
  return channel?.broadcasterLanguage ?? null;
}

export class LiveChat {
  readonly #deps: LiveChatDependencies;
  readonly #clients = new Map<string, EventSubClient>();
  // Shared with raids, because a refresh token works only once.
  readonly #tokens = new Map<string, AccessTokenProvider>();
  readonly #createClient: NonNullable<LiveChatOptions['createClient']>;
  readonly #channelLanguage: NonNullable<LiveChatOptions['channelLanguage']>;
  readonly #maxConnections: number;

  constructor(dependencies: LiveChatDependencies) {
    this.#deps = dependencies;
    this.#createClient = dependencies.createClient ?? createEventSubClient;
    this.#channelLanguage = dependencies.channelLanguage ?? readChannelLanguage;
    this.#maxConnections = dependencies.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }

  // Never rejects, so a chat problem cannot fail the login that triggered it.
  async connect(session: UserSession): Promise<void> {
    const channelId = session.user.id;
    if (!hasRequiredScopes(session.tokens.scope)) {
      this.#deps.reportError('Twitch chat needs a new login with the required permissions.');
      return;
    }
    if (!this.#clients.has(channelId) && this.#clients.size >= this.#maxConnections) {
      this.#deps.reportError('Twitch chat could not connect because the server is at capacity.');
      return;
    }
    await this.#register(session);
    try {
      const config = loadOAuthConfig(process.env);
      this.#clients.get(channelId)?.stop();
      const getAccessToken = createSessionTokenProvider({ userId: channelId, config });
      const client: EventSubClient = this.#createClient({
        clientId: config.clientId, userId: channelId, getAccessToken,
        onNotification: (notification) => {
          if (this.#clients.get(channelId) === client) this.#route(channelId, notification);
        },
        reportError: this.#deps.reportError,
      });
      this.#clients.set(channelId, client);
      this.#tokens.set(channelId, getAccessToken);
      client.start();
      void client.watchChat(channelId);
    } catch {
      this.#deps.reportError('Twitch chat could not connect.');
    }
  }

  disconnect(channelId: string): void {
    this.#clients.get(channelId)?.stop();
    this.#clients.delete(channelId);
    this.#tokens.delete(channelId);
  }

  tokenProvider(channelId: string): AccessTokenProvider | null {
    return this.#tokens.get(channelId) ?? null;
  }

  state(channelId: string): LiveChatState {
    const client = this.#clients.get(channelId);
    if (!client) return 'offline';
    return client.isWatchingChat(channelId) ? 'ready' : 'connecting';
  }

  // Channels whose chat is confirmed, so translation can work there.
  readyChannels(): string[] {
    return [...this.#clients.keys()].filter((channelId) => this.state(channelId) === 'ready');
  }

  close(): void {
    for (const client of this.#clients.values()) client.stop();
    this.#clients.clear();
    this.#tokens.clear();
  }

  // The roulette only runs for known streamers. A failure leaves chat working without it.
  async #register(session: UserSession): Promise<void> {
    const { user } = session;
    try {
      const stored = await this.#deps.streamers.findById(user.id);
      const language = await this.#channelLanguage(session).catch(() => null);
      const supported = languageCodeSchema.safeParse(language);
      const streamer: Streamer = {
        id: user.id, login: user.login, displayName: user.display_name,
        avatarUrl: user.profile_image_url.startsWith('https://') ? user.profile_image_url : null,
        language: supported.success ? supported.data : stored?.language ?? DEFAULT_LANGUAGE,
        minViewers: stored?.minViewers ?? 0, maxViewers: stored?.maxViewers ?? OPEN_MAX_VIEWERS,
        acceptsOtherLanguages: stored?.acceptsOtherLanguages ?? true, reputation: stored?.reputation ?? 0,
      };
      await this.#deps.streamers.save(streamer);
    } catch {
      this.#deps.reportError('The Twitch channel could not be registered.');
    }
  }

  #route(channelId: string, notification: EventSubNotification): void {
    if (notification.type === 'channel.chat.message') {
      this.#routeChat(channelId, notification.event, notification.receivedAtMs);
      return;
    }
    if (notification.type === 'channel.raid') {
      // This connection subscribes only to raids leaving its authenticated broadcaster.
      if (notification.event.from_broadcaster_user_id !== channelId) return;
      this.#deliver(this.#deps.commands.handleArrival(toRaidArrival(notification.eventId, notification.event, notification.receivedAtMs)));
      return;
    }
    const action = toModerationAction(notification);
    if (action?.channelId === channelId) this.#deliver(this.#deps.chat.handleModeration(action));
  }

  #routeChat(channelId: string, event: ChannelChatMessageEvent, receivedAtMs: number): void {
    if (event.broadcaster_user_id !== channelId || event.message.text.trim() === '') return;
    const message = toChatMessage(event, receivedAtMs);
    const command = isFromAnotherChannel(event) ? null : toChatCommand(message);
    if (command) void this.#deps.commands.handleCommand(command);
    const fragments = toChatFragments(event);
    // The language stays unknown until detection exists; it is never guessed.
    this.#deliver(this.#deps.chat.handleMessage(toChatTextMessage(message, {
      displayName: event.chatter_user_name, sourceLanguage: null, ...(fragments ? { fragments } : {}),
    })));
  }

  #deliver(task: Promise<void>): void {
    task.catch(() => { this.#deps.reportError('A Twitch chat event could not be handled.'); });
  }
}
