import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerEvent } from '@raidsphere/shared';
import { createRuntime } from '../src/composition.js';
import { CommandSimulator } from '../src/simulation/commands.js';
import { OVERLAY_ORIGIN } from '../src/websocket.js';
import type { ViewingLimits } from '../src/websocket.js';

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

function connect(url: string, origin: string | null = OVERLAY_ORIGIN) {
  const socket = new WebSocket(url, origin === null ? {} : { origin });
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
