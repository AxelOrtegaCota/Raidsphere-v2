import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createEventSubClient, type EventSubClient, type EventSubClientOptions, type EventSubNotification,
} from '../src/twitch/eventsub.js';

// A real local WebSocket server stands in for Twitch; every value is a test fixture.
const TOKEN = 'fixture-access-token';
const BROADCASTER = '1001';

interface HelixCall { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }

type Responder = (call: HelixCall, index: number) => Response | null;

function createHelix(responder: Responder = () => null): { calls: HelixCall[]; fetch: typeof fetch; posts: () => HelixCall[] } {
  const calls: HelixCall[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: HelixCall = {
      method: init?.method ?? 'GET', url: String(input),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    };
    calls.push(call);
    const custom = responder(call, calls.length - 1);
    if (custom) return custom;
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: [{ id: `sub-${calls.length}` }] }), { status: 202 });
  }) as typeof fetch;
  return { calls, fetch: fetchFake, posts: () => calls.filter((call) => call.method === 'POST') };
}

const welcome = (id: string, keepalive = 10): string => JSON.stringify({
  metadata: { message_id: `welcome-${id}`, message_type: 'session_welcome', message_timestamp: '2026-10-31T00:00:00Z' },
  payload: { session: { id, status: 'connected', connected_at: '2026-10-31T00:00:00Z', keepalive_timeout_seconds: keepalive, reconnect_url: null } },
});

const keepalive = (id: string): string => JSON.stringify({
  metadata: { message_id: id, message_type: 'session_keepalive', message_timestamp: '2026-10-31T00:00:00Z' },
  payload: {},
});

const subscription = (type: string, status = 'enabled') => ({
  id: 'sub-x', type, version: '1', status, cost: 0, condition: {},
  transport: { method: 'websocket', session_id: 's' }, created_at: '2026-10-31T00:00:00Z',
});

const notification = (id: string, type: string, event: unknown): string => JSON.stringify({
  metadata: {
    message_id: id, message_type: 'notification', message_timestamp: '2026-10-31T00:00:00Z',
    subscription_type: type, subscription_version: '1',
  },
  payload: { subscription: subscription(type), event },
});

const raidEvent = {
  from_broadcaster_user_id: BROADCASTER, from_broadcaster_user_login: 'origin', from_broadcaster_user_name: 'Origin',
  to_broadcaster_user_id: '2002', to_broadcaster_user_login: 'target', to_broadcaster_user_name: 'Target',
  viewers: 42,
};

const chatEvent = {
  broadcaster_user_id: '2002', broadcaster_user_login: 'target', broadcaster_user_name: 'Target',
  chatter_user_id: '3003', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
  message_id: 'chat-1', message: { text: 'private chat text', fragments: [{ type: 'text', text: 'private chat text' }] },
  color: '', badges: [],
};

describe('EventSub client', () => {
  let server: WebSocketServer;
  let sockets: WebSocket[];
  let client: EventSubClient | null;
  let notifications: EventSubNotification[];
  let errors: string[];

  const url = (): string => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

  const startClient = (
    helix: ReturnType<typeof createHelix>, overrides: Partial<EventSubClientOptions> = {},
  ): EventSubClient => {
    client = createEventSubClient({
      clientId: 'fixture-client', userId: BROADCASTER,
      getAccessToken: async () => TOKEN,
      onNotification: (item) => { notifications.push(item); },
      reportError: (message) => { errors.push(message); },
      url: url(), fetch: helix.fetch, reconnectBaseMs: 5, retryBaseMs: 1,
      ...overrides,
    });
    client.start();
    return client;
  };

  const socketAt = async (index: number): Promise<WebSocket> => {
    await vi.waitFor(() => { expect(sockets.length).toBeGreaterThan(index); });
    return sockets[index] as WebSocket;
  };

  beforeEach(async () => {
    sockets = [];
    notifications = [];
    errors = [];
    client = null;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket) => { sockets.push(socket); });
    await new Promise((resolve) => { server.once('listening', resolve); });
  });

  afterEach(async () => {
    client?.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => { server.close(resolve); });
  });

  it('connects and subscribes to raids leaving the broadcaster channel', async () => {
    const helix = createHelix();
    const events = startClient(helix);
    expect(events.status()).toBe('connecting');

    (await socketAt(0)).send(welcome('session-1'));

    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });
    const [call] = helix.posts();
    expect(call?.body).toEqual({
      type: 'channel.raid', version: '1',
      condition: { from_broadcaster_user_id: BROADCASTER },
      transport: { method: 'websocket', session_id: 'session-1' },
    });
    expect(call?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Client-Id': 'fixture-client' });
    expect(call?.url).not.toContain(TOKEN);
    expect(events.status()).toBe('connected');
  });

  it('subscribes to chat and moderation events, and removes them when asked', async () => {
    const helix = createHelix();
    const events = startClient(helix);
    (await socketAt(0)).send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    expect(events.isWatchingChat('2002')).toBe(false);
    await expect(events.watchChat('2002')).resolves.toBe(true);
    expect(events.isWatchingChat('2002')).toBe(true);

    const chatCalls = helix.posts().slice(1);
    expect(chatCalls.map((call) => call.body?.['type']).sort()).toEqual([
      'channel.chat.clear', 'channel.chat.clear_user_messages', 'channel.chat.message', 'channel.chat.message_delete',
    ]);
    for (const call of chatCalls) {
      expect(call.body?.['condition']).toEqual({ broadcaster_user_id: '2002', user_id: BROADCASTER });
    }

    await events.unwatchChat('2002');
    const deletes = helix.calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(4);
    expect(deletes[0]?.url).toContain('/eventsub/subscriptions?id=sub-');
  });

  it('stays connected on keepalives that carry an empty payload', async () => {
    const helix = createHelix();
    startClient(helix);
    const socket = await socketAt(0);
    socket.send(welcome('session-1', 0.06));
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      socket.send(keepalive(`keepalive-${index}`));
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(sockets).toHaveLength(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('reconnects and subscribes again when keepalives stop', async () => {
    const helix = createHelix();
    const events = startClient(helix);
    (await socketAt(0)).send(welcome('session-1', 0.02));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    const second = await socketAt(1);
    expect(events.status()).toBe('reconnecting');
    second.send(welcome('session-2'));

    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(2); });
    expect((helix.posts()[1]?.body?.['transport'] as { session_id: string }).session_id).toBe('session-2');
  });

  it('recreates every subscription after a dropped connection', async () => {
    const helix = createHelix();
    const events = startClient(helix);
    const first = await socketAt(0);
    first.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });
    await events.watchChat('2002');

    first.close(4006, 'network error');
    (await socketAt(1)).send(welcome('session-2'));

    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(10); });
    const renewed = helix.posts().slice(5);
    expect(renewed.every((call) => (call.body?.['transport'] as { session_id: string }).session_id === 'session-2')).toBe(true);
  });

  it('keeps the old connection until the reconnect welcome, without subscribing again', async () => {
    const helix = createHelix();
    startClient(helix);
    const first = await socketAt(0);
    first.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    first.send(JSON.stringify({
      metadata: { message_id: 'reconnect-1', message_type: 'session_reconnect', message_timestamp: '2026-10-31T00:00:00Z' },
      payload: { session: { id: 'session-1', status: 'reconnecting', connected_at: '2026-10-31T00:00:00Z', keepalive_timeout_seconds: null, reconnect_url: `${url()}?reconnect=1` } },
    }));
    const second = await socketAt(1);

    first.send(notification('event-old', 'channel.raid', raidEvent));
    await vi.waitFor(() => { expect(notifications).toHaveLength(1); });
    expect(first.readyState).toBe(WebSocket.OPEN);

    second.send(welcome('session-1b'));
    await vi.waitFor(() => { expect(first.readyState).toBe(WebSocket.CLOSED); });
    expect(helix.posts()).toHaveLength(1);

    second.send(notification('event-new', 'channel.raid', raidEvent));
    await vi.waitFor(() => { expect(notifications).toHaveLength(2); });
  });

  it('ignores a reconnect URL outside the configured or Twitch hosts', async () => {
    const helix = createHelix();
    startClient(helix);
    const first = await socketAt(0);
    first.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    first.send(JSON.stringify({
      metadata: { message_id: 'reconnect-1', message_type: 'session_reconnect', message_timestamp: '2026-10-31T00:00:00Z' },
      payload: { session: { id: 'session-1', status: 'reconnecting', connected_at: '2026-10-31T00:00:00Z', keepalive_timeout_seconds: null, reconnect_url: 'wss://attacker.example/ws' } },
    }));

    await vi.waitFor(() => { expect(errors).toContain('EventSub sent a reconnect URL outside the expected hosts.'); });
    expect(sockets).toHaveLength(1);
  });

  it('delivers validated events once, even when Twitch repeats a message', async () => {
    const helix = createHelix();
    startClient(helix);
    const socket = await socketAt(0);
    socket.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    socket.send(notification('event-1', 'channel.raid', raidEvent));
    socket.send(notification('event-1', 'channel.raid', raidEvent));
    socket.send(notification('event-2', 'channel.chat.message', chatEvent));

    await vi.waitFor(() => { expect(notifications).toHaveLength(2); });
    expect(notifications[0]).toMatchObject({ eventId: 'event-1', type: 'channel.raid', event: { viewers: 42 } });
    expect(notifications[1]).toMatchObject({ eventId: 'event-2', type: 'channel.chat.message', event: { message_id: 'chat-1' } });
    expect(typeof notifications[0]?.receivedAtMs).toBe('number');
  });

  it('drops malformed frames without exposing their content', async () => {
    const helix = createHelix();
    startClient(helix);
    const socket = await socketAt(0);
    socket.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    socket.send('private chat text {');
    socket.send(notification('event-1', 'channel.chat.message', { ...chatEvent, chatter_user_id: 7 }));
    socket.send(notification('event-2', 'channel.unexpected', { value: 'private chat text' }));
    socket.send(notification('event-3', 'channel.raid', raidEvent));

    await vi.waitFor(() => { expect(notifications).toHaveLength(1); });
    expect(notifications[0]?.eventId).toBe('event-3');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).not.toContain('private chat text');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('survives a notification handler that throws', async () => {
    const helix = createHelix();
    startClient(helix, {
      onNotification: (item) => {
        notifications.push(item);
        if (item.eventId === 'event-1') throw new Error('handler failure');
      },
    });
    const socket = await socketAt(0);
    socket.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    socket.send(notification('event-1', 'channel.raid', raidEvent));
    socket.send(notification('event-2', 'channel.raid', raidEvent));

    await vi.waitFor(() => { expect(notifications).toHaveLength(2); });
    expect(errors).toContain('An EventSub event could not be handled.');
  });

  it('refreshes the token once after a 401 response', async () => {
    const helix = createHelix((call, index) => (index === 0 ? new Response(null, { status: 401 }) : null));
    const getAccessToken = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => (forceRefresh ? 'refreshed-token' : TOKEN));
    startClient(helix, { getAccessToken });
    (await socketAt(0)).send(welcome('session-1'));

    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(2); });
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
    expect(helix.posts()[1]?.headers['Authorization']).toBe('Bearer refreshed-token');
  });

  it('retries rate limits, and stops at a permanent rejection', async () => {
    const helix = createHelix((call, index) => {
      if (index === 0) return new Response(null, { status: 429 });
      if (call.body?.['type'] === 'channel.chat.message') return new Response('private body', { status: 403 });
      return null;
    });
    const events = startClient(helix);
    (await socketAt(0)).send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(2); });

    await expect(events.watchChat('2002')).resolves.toBe(false);

    expect(helix.posts().filter((call) => call.body?.['type'] === 'channel.chat.message')).toHaveLength(1);
    expect(errors).toContain('EventSub rejected channel.chat.message with status 403.');
    expect(errors.join(' ')).not.toContain('private body');
  });

  it('does not recreate a revoked subscription', async () => {
    const helix = createHelix();
    const onRevoked = vi.fn();
    startClient(helix, { onRevoked });
    const first = await socketAt(0);
    first.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    first.send(JSON.stringify({
      metadata: { message_id: 'revocation-1', message_type: 'revocation', message_timestamp: '2026-10-31T00:00:00Z', subscription_type: 'channel.raid', subscription_version: '1' },
      payload: { subscription: { ...subscription('channel.raid', 'authorization_revoked'), id: 'sub-1' } },
    }));
    await vi.waitFor(() => { expect(onRevoked).toHaveBeenCalledWith('channel.raid', 'authorization_revoked'); });

    first.close(4006, 'network error');
    (await socketAt(1)).send(welcome('session-2'));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(helix.posts()).toHaveLength(1);
  });

  it('stays stopped after stop()', async () => {
    const helix = createHelix();
    const events = startClient(helix);
    const socket = await socketAt(0);
    socket.send(welcome('session-1'));
    await vi.waitFor(() => { expect(helix.posts()).toHaveLength(1); });

    events.stop();

    await vi.waitFor(() => { expect(socket.readyState).toBe(WebSocket.CLOSED); });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(sockets).toHaveLength(1);
    expect(events.status()).toBe('stopped');
  });
});
