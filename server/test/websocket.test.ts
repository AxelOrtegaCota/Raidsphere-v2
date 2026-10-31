import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerEvent } from '@raidsphere/shared';
import { createRuntime } from '../src/composition.js';
import { CommandSimulator } from '../src/simulation/commands.js';
import { OVERLAY_ORIGIN, sendOrDrop } from '../src/websocket.js';
import type { ViewerSocket, ViewingLimits } from '../src/websocket.js';

// Real loopback server on a random port; all identifiers are synthetic fixtures.
const SOURCE = 'rsdemo_es_01';
const OTHER = 'rsdemo_ja_01';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(limits: Partial<ViewingLimits> = {}) {
  const errors: string[] = [];
  const runtime = createRuntime({ reportError: (message) => { errors.push(message); }, viewingLimits: limits });
  await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => runtime.app.close());
  const { port } = runtime.app.server.address() as AddressInfo;
  const credential = (channelId: string) => runtime.issuedCredentials.get(channelId) ?? '';
  return { runtime, errors, url: `ws://127.0.0.1:${port}`, credential };
}

function connect(url: string, origin: string | null = OVERLAY_ORIGIN, options: { autoPong?: boolean } = {}) {
  const socket = new WebSocket(url, origin === null ? options : { ...options, origin });
  cleanups.push(() => socket.terminate());
  const events: ServerEvent[] = [];
  const checks = new Set<() => void>();
  socket.on('message', (data) => {
    events.push(JSON.parse(data.toString()) as ServerEvent);
    for (const check of [...checks]) check();
  });
  socket.on('error', () => undefined);
  const received = (count: number) => new Promise<ServerEvent[]>((resolve) => {
    const check = () => {
      if (events.length < count) return;
      checks.delete(check);
      resolve(events.slice(0, count));
    };
    checks.add(check);
    check();
  });
  const opened = new Promise<void>((resolve) => { socket.on('open', () => resolve()); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const rejectedWith = new Promise<number>((resolve) => {
    socket.on('unexpected-response', (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
  });
  const auth = (channelId: string, viewingCredential: string) => socket.send(JSON.stringify({
    version: 1, type: 'auth', payload: { channelId, viewingCredential },
  }));
  return { socket, events, received, opened, closed, rejectedWith, auth };
}

describe('viewing WebSocket upgrades', () => {
  it('rejects other paths, other origins, and missing origins', async () => {
    const { url } = await startServer();
    expect(await connect(`${url}/other`).rejectedWith).toBe(404);
    expect(await connect(`${url}/ws`, 'http://localhost:5173').rejectedWith).toBe(403);
    expect(await connect(`${url}/ws`, null).rejectedWith).toBe(403);
  });

  it('rejects upgrades above the total connection limit', async () => {
    const { url } = await startServer({ maxConnections: 1 });
    await connect(`${url}/ws`).opened;
    expect(await connect(`${url}/ws`).rejectedWith).toBe(503);
  });
});

describe('viewing WebSocket authentication', () => {
  it('closes a connection that does not authenticate in time, without a reason', async () => {
    const { url } = await startServer({ authTimeoutMs: 50 });
    const viewer = connect(`${url}/ws`);
    expect(await viewer.closed).toEqual({ code: 1008, reason: '' });
  });

  it.each([
    ['malformed JSON', (send: (text: string) => void) => send('{not json')],
    ['a control command', (send: (text: string) => void) => send(JSON.stringify({ version: 1, type: 'roulette:start', payload: {} }))],
  ])('closes on %s', async (_label, sendInvalid) => {
    const { url } = await startServer();
    const viewer = connect(`${url}/ws`);
    await viewer.opened;
    sendInvalid((text) => viewer.socket.send(text));
    expect(await viewer.closed).toEqual({ code: 1008, reason: '' });
  });

  it('closes on a wrong credential or another channel credential', async () => {
    const { url, credential } = await startServer();
    for (const presented of ['x'.repeat(43), credential(OTHER)]) {
      const viewer = connect(`${url}/ws`);
      await viewer.opened;
      viewer.auth(SOURCE, presented);
      expect(await viewer.closed).toEqual({ code: 1008, reason: '' });
      expect(viewer.events).toEqual([]);
    }
  });

  it('closes when the channel connection limit is reached', async () => {
    const { url, credential } = await startServer({ maxConnectionsPerChannel: 1 });
    const first = connect(`${url}/ws`);
    await first.opened;
    first.auth(SOURCE, credential(SOURCE));
    await first.received(1);
    const second = connect(`${url}/ws`);
    await second.opened;
    second.auth(SOURCE, credential(SOURCE));
    expect((await second.closed).code).toBe(1013);
  });
});

describe('viewing WebSocket delivery', () => {
  it('sends the snapshot first, then only live events of the authenticated channel', async () => {
    const { url, credential, runtime, errors } = await startServer();
    const source = connect(`${url}/ws`);
    const other = connect(`${url}/ws`);
    await Promise.all([source.opened, other.opened]);
    source.auth(SOURCE, credential(SOURCE));
    other.auth(OTHER, credential(OTHER));
    const [snapshot] = await source.received(1);
    await other.received(1);
    expect(snapshot).toMatchObject({ type: 'state:snapshot', channelId: SOURCE, payload: { roulette: null, translationWindow: null } });

    const chat = new CommandSimulator(runtime.coordinator, SOURCE);
    await chat.roulette();
    await chat.vote('viewer-1', 'ja');
    const [, started, votes] = await source.received(3);
    expect(started?.type).toBe('roulette:start');
    expect(votes?.type).toBe('roulette:votes');
    expect((started?.sequence ?? 0) > (snapshot?.sequence ?? 0)).toBe(true);
    await pause(50);
    expect(other.events.map((event) => event.type)).toEqual(['state:snapshot']);
    expect(errors).toEqual([]);
  });

  it('includes an active session in the snapshot of a late viewer', async () => {
    const { url, credential, runtime } = await startServer();
    await new CommandSimulator(runtime.coordinator, SOURCE).roulette();
    const viewer = connect(`${url}/ws`);
    await viewer.opened;
    viewer.auth(SOURCE, credential(SOURCE));
    const [snapshot] = await viewer.received(1);
    expect(snapshot).toMatchObject({ type: 'state:snapshot', payload: { roulette: { status: 'voting', fromStreamerId: SOURCE } } });
  });

  it('closes the connection on any message after authentication', async () => {
    const { url, credential } = await startServer();
    const viewer = connect(`${url}/ws`);
    await viewer.opened;
    viewer.auth(SOURCE, credential(SOURCE));
    await viewer.received(1);
    viewer.socket.send('{}');
    expect(await viewer.closed).toEqual({ code: 1008, reason: '' });
  });
});

describe('viewing WebSocket heartbeat', () => {
  it('keeps a viewer that answers pings connected', async () => {
    const { url, credential } = await startServer({ heartbeatIntervalMs: 20 });
    const viewer = connect(`${url}/ws`);
    let pings = 0;
    viewer.socket.on('ping', () => { pings += 1; });
    await viewer.opened;
    viewer.auth(SOURCE, credential(SOURCE));
    await viewer.received(1);
    await pause(150);
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a viewer that stops answering pings and frees its channel slot', async () => {
    const { url, credential } = await startServer({ heartbeatIntervalMs: 20, maxConnectionsPerChannel: 1 });
    const silent = connect(`${url}/ws`, OVERLAY_ORIGIN, { autoPong: false });
    await silent.opened;
    silent.auth(SOURCE, credential(SOURCE));
    await silent.received(1);
    // A terminated connection ends without a close frame.
    expect((await silent.closed).code).toBe(1006);

    const next = connect(`${url}/ws`);
    await next.opened;
    next.auth(SOURCE, credential(SOURCE));
    const [snapshot] = await next.received(1);
    expect(snapshot?.type).toBe('state:snapshot');
  });
});

describe('viewing WebSocket shutdown', () => {
  it('disconnects connected viewers so the server can close', async () => {
    const runtime = createRuntime({ reportError: () => undefined });
    await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = runtime.app.server.address() as AddressInfo;
    const viewer = connect(`ws://127.0.0.1:${port}/ws`);
    await viewer.opened;
    viewer.auth(SOURCE, runtime.issuedCredentials.get(SOURCE) ?? '');
    await viewer.received(1);

    const closedInTime = await Promise.race([
      runtime.app.close().then(() => true),
      pause(2_000).then(() => false),
    ]);
    expect(closedInTime).toBe(true);
    // An abnormal close is not a credential rejection, so the overlay retries.
    expect((await viewer.closed).code).toBe(1006);
  });
});

describe('viewing WebSocket outgoing buffer limit', () => {
  const event = {
    version: 1, type: 'state:snapshot', eventId: '00000000-0000-4000-8000-000000000000', channelId: SOURCE,
    occurredAtMs: 1_000_000, sequence: 0, payload: { roulette: null, translationWindow: null },
  } as ServerEvent;

  function fakeViewer(bufferedAmount: number, readyState: number = WebSocket.OPEN) {
    const sent: string[] = [];
    let terminated = false;
    const viewer = {
      readyState, bufferedAmount,
      send: (data: string) => { sent.push(data); },
      terminate: () => { terminated = true; },
    } as unknown as ViewerSocket;
    return { viewer, sent, terminated: () => terminated };
  }

  it('sends while the buffer is within the limit', () => {
    const { viewer, sent, terminated } = fakeViewer(1_024);
    sendOrDrop(viewer, event, 1_024);
    expect(sent).toEqual([JSON.stringify(event)]);
    expect(terminated()).toBe(false);
  });

  it('terminates instead of sending once the buffer exceeds the limit', () => {
    const { viewer, sent, terminated } = fakeViewer(1_025);
    sendOrDrop(viewer, event, 1_024);
    expect(sent).toEqual([]);
    expect(terminated()).toBe(true);
  });

  it('does nothing on a socket that is not open', () => {
    const { viewer, sent, terminated } = fakeViewer(0, WebSocket.CLOSING);
    sendOrDrop(viewer, event, 1_024);
    expect(sent).toEqual([]);
    expect(terminated()).toBe(false);
  });
});
