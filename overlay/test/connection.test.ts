import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@raidsphere/shared';
import type { ServerEvent } from '@raidsphere/shared';
import { connectToChannel, readOverlayTarget, webSocketUrl } from '../src/connection.js';
import type { ConnectionStatus } from '../src/connection.js';

// All identifiers are synthetic fixtures.
const CHANNEL = 'rsdemo_es_01';
const CREDENTIAL = 'c'.repeat(43);

// Minimal stand-in for the browser WebSocket: records what the client sends and lets a test
// play the server side of the connection.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: 'open' | 'message' | 'close', event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let sequence = 0;
function wireEvent(channelId = CHANNEL): string {
  sequence += 1;
  return JSON.stringify({
    version: PROTOCOL_VERSION, type: 'state:snapshot', eventId: randomUUID(), channelId,
    occurredAtMs: 1_000_000, sequence, payload: { roulette: null, translationWindow: null },
  });
}

function startClient() {
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const stop = connectToChannel(
    { channelId: CHANNEL, credential: CREDENTIAL },
    { onEvent: (event) => events.push(event), onStatus: (status) => statuses.push(status) },
  );
  const latest = (): FakeWebSocket => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('No socket was opened.');
    return socket;
  };
  return { events, statuses, stop, latest };
}

describe('production overlay connection', () => {
  it('uses a secure same-origin WebSocket URL on HTTPS', () => {
    expect(webSocketUrl({ protocol: 'https:', host: 'raidsphere.up.railway.app' }))
      .toBe('wss://raidsphere.up.railway.app/ws');
  });

  it('keeps an insecure same-origin WebSocket URL for local HTTP development', () => {
    expect(webSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }))
      .toBe('ws://127.0.0.1:5173/ws');
  });

  it('reads the channel and credential from an OBS overlay URL', () => {
    const location = {
      pathname: '/themask957/overlay',
      search: '',
      hash: `#cred=${'x'.repeat(43)}`,
    } as Location;
    let replaced = '';
    const history = { replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
      replaced = String(url ?? '');
    } } as History;

    expect(readOverlayTarget(location, history)).toEqual({
      channelId: 'themask957',
      credential: 'x'.repeat(43),
    });
    expect(replaced).toBe('/themask957/overlay');
  });
});

describe('overlay connection lifecycle', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:5173' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('authenticates once opened and goes live on the snapshot', () => {
    const client = startClient();
    const socket = client.latest();
    expect(socket.url).toBe('ws://127.0.0.1:5173/ws');
    expect(client.statuses).toEqual([{ kind: 'connecting' }]);

    socket.emit('open');
    expect(socket.sent.map((text) => JSON.parse(text) as unknown)).toEqual([{
      version: PROTOCOL_VERSION, type: 'auth', payload: { channelId: CHANNEL, viewingCredential: CREDENTIAL },
    }]);

    socket.emit('message', { data: wireEvent() });
    expect(client.statuses.at(-1)).toEqual({ kind: 'live' });
    expect(client.events.map((event) => event.type)).toEqual(['state:snapshot']);
  });

  it('ignores binary, malformed, invalid, and other-channel messages', () => {
    const client = startClient();
    const socket = client.latest();
    socket.emit('message', { data: new ArrayBuffer(4) });
    socket.emit('message', { data: '{not json' });
    socket.emit('message', { data: JSON.stringify({ type: 'state:snapshot' }) });
    socket.emit('message', { data: wireEvent('rsdemo_ja_01') });
    expect(client.events).toEqual([]);
    expect(client.statuses).toEqual([{ kind: 'connecting' }]);
  });

  it('reconnects after a lost connection with a growing, capped delay', () => {
    const client = startClient();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      client.latest().emit('close', { code: 1006 });
      const status = client.statuses.at(-1);
      expect(status?.kind).toBe('reconnecting');
      const retryInMs = status?.kind === 'reconnecting' ? status.retryInMs : 0;
      delays.push(retryInMs);
      const before = FakeWebSocket.instances.length;
      vi.advanceTimersByTime(retryInMs - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('resets the delay after a reconnection receives a fresh snapshot', () => {
    const client = startClient();
    client.latest().emit('close', { code: 1006 });
    vi.advanceTimersByTime(1_000);
    client.latest().emit('close', { code: 1006 });
    vi.advanceTimersByTime(2_000);

    const reconnected = client.latest();
    reconnected.emit('open');
    reconnected.emit('message', { data: wireEvent() });
    expect(client.statuses.at(-1)).toEqual({ kind: 'live' });

    reconnected.emit('close', { code: 1006 });
    expect(client.statuses.at(-1)).toEqual({ kind: 'reconnecting', retryInMs: 1_000 });
  });

  it('stops retrying when the server rejects the credential', () => {
    const client = startClient();
    client.latest().emit('close', { code: 1008 });
    expect(client.statuses.at(-1)).toEqual({ kind: 'rejected' });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the socket and cancels a pending retry when stopped', () => {
    const client = startClient();
    client.latest().emit('close', { code: 1006 });
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.latest().closed).toBe(true);

    const statusesBefore = client.statuses.length;
    client.latest().emit('close', { code: 1006 });
    expect(client.statuses).toHaveLength(statusesBefore);
  });
});
