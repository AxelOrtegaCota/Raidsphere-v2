import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/composition.js';
import { loadServerConfig } from '../src/config.js';
import { startupLines } from '../src/startup.js';
import { MockTranslationProvider } from '../src/translation/mock-provider.js';

const createApp = () => createRuntime({ reportError: () => undefined }).app;

describe('server boundaries', () => {
  it('reports simulation mode, read-only subscriptions, and authenticated control support', async () => {
    const app = createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        application: 'RaidSphere', status: 'ok', protocolVersion: 1, mode: 'simulation', translation: 'simulated',
        capabilities: { channelSubscriptions: true, controlCommands: true },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      const missing = await app.inject({ method: 'GET', url: '/unknown' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'Not found.' });
    } finally {
      await app.close();
    }
  });

  it('reports real translation only when a provider is configured', async () => {
    const translation = Object.assign(new MockTranslationProvider(), { detect: async () => null });
    const app = createRuntime({ reportError: () => undefined, translation }).app;
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.json()).toMatchObject({ mode: 'simulation', translation: 'real' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['/ws?fixture=must-not-be-reflected', '403 Forbidden'],
    ['/other?fixture=must-not-be-reflected', '404 Not Found'],
  ])('rejects the upgrade %s without an allowed origin and without reflecting request data', async (url, status) => {
    const app = createApp();
    const requestSocket = new Socket();
    const responseSocket = new PassThrough();
    const chunks: Buffer[] = [];
    responseSocket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    try {
      await app.ready();
      const request = new IncomingMessage(requestSocket);
      request.url = url;
      app.server.emit('upgrade', request, responseSocket, Buffer.alloc(0));
      const response = Buffer.concat(chunks).toString('utf8');
      expect(response).toContain(status);
      expect(response).not.toContain('must-not-be-reflected');
      expect(response).not.toContain('101 Switching Protocols');
    } finally {
      responseSocket.destroy();
      requestSocket.destroy();
      await app.close();
    }
  });

  it('uses loopback defaults and rejects invalid ports', () => {
    expect(loadServerConfig({})).toEqual({ host: '127.0.0.1', port: 3000 });
    for (const PORT of ['', '0', '65536', 'invalid', '3000.5']) {
      expect(() => loadServerConfig({ PORT })).toThrow();
    }
  });

  it.each([
    ['1', 1], ['3000', 3000], ['03000', 3000], ['65535', 65535],
  ] as const)('accepts the decimal port %s without changing the loopback host', (PORT, port) => {
    expect(loadServerConfig({ PORT })).toEqual({ host: '127.0.0.1', port });
  });

  it.each([
    '', '0', '00000', '65536', '100000', '0003000', '-1', '+3000',
    ' 3000', '3000 ', '\t3000', '3000\n', '0xBB8', '3e3', '3000.0', '3000.5',
    'invalid', '\u0663\u0660\u0660\u0660',
  ])('rejects a port that is not a bounded decimal port: %j', (PORT) => {
    expect(() => loadServerConfig({ PORT })).toThrow();
  });
});

describe('startup log', () => {
  const urls = [{ channelId: 'rsdemo_es_01', url: `http://127.0.0.1:5173/rsdemo_es_01/overlay#cred=${'x'.repeat(43)}` }];

  it('prints overlay URLs with their credentials on a loopback binding', () => {
    const lines = startupLines(loadServerConfig({}), urls);
    expect(lines[0]).toContain('loopback port 3000');
    expect(lines).toContain(`  rsdemo_es_01: ${urls[0]?.url ?? ''}`);
  });

  it('never prints a viewing credential on a public binding', () => {
    const lines = startupLines(loadServerConfig({ HOST: '0.0.0.0', PORT: '8080' }), urls);
    expect(lines.join('\n')).not.toContain('#cred=');
    expect(lines.join('\n')).not.toContain('x'.repeat(43));
    expect(lines[0]).not.toContain('loopback');
  });
});
