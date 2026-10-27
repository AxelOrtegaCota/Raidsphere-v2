import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024;

export function registerWebSocketBoundary(app: FastifyInstance): void {
  // No socket can join a channel until the viewing authorization adapter exists.
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    socket.on('error', () => socket.destroy());
    const isEndpoint = request.url?.split('?')[0] === '/ws';
    const status = isEndpoint ? '503 Service Unavailable' : '404 Not Found';
    const body = isEndpoint ? 'Overlay authorization is not implemented.\n' : 'Not found.\n';
    // Never echo the requested URL, query parameters, headers, or credentials.
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`,
      () => socket.destroy(),
    );
  };

  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', async () => {
    app.server.off('upgrade', onUpgrade);
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  });
}
