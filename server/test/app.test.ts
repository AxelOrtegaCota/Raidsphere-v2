import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';

describe('foundation server boundaries', () => {
  it('provides health without advertising implemented channel or control access', async () => {
    const app = createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        application: 'RaidSphere', status: 'ok', protocolVersion: 1,
        capabilities: { channelSubscriptions: false, controlCommands: false },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      const missing = await app.inject({ method: 'GET', url: '/unknown' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'Not found.' });
    } finally {
      await app.close();
    }
  });

  it('rejects an upgrade before creating a WebSocket or reflecting request data', async () => {
    const app = createApp();
    const requestSocket = new Socket();
    const responseSocket = new PassThrough();
    const chunks: Buffer[] = [];
    responseSocket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    try {
      await app.ready();
      const request = new IncomingMessage(requestSocket);
      request.url = '/ws?fixture=must-not-be-reflected';
      app.server.emit('upgrade', request, responseSocket, Buffer.alloc(0));
      const response = Buffer.concat(chunks).toString('utf8');
      expect(response).toContain('503 Service Unavailable');
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
