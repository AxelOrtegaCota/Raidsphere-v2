import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { clientMessageSchema } from '@raidsphere/shared';
import type { ServerEvent } from '@raidsphere/shared';
import type { EventListener } from './application/publisher.js';
import type { ViewingCredentials } from './viewing/credentials.js';

// Read-only viewing transport (D2-11). A socket only receives the events of the one channel
// whose viewing credential it presented; it can never send commands.

export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024;
export const OVERLAY_ORIGIN = 'http://127.0.0.1:5173';

export interface ViewingLimits {
  authTimeoutMs: number;
  maxConnectionsPerChannel: number;
  maxConnections: number;
  heartbeatIntervalMs: number;
  maxBufferedBytes: number;
}

export const DEFAULT_VIEWING_LIMITS: ViewingLimits = {
  authTimeoutMs: 5_000,
  maxConnectionsPerChannel: 4,
  maxConnections: 16,
  heartbeatIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
};

export interface ViewSource {
  openView(channelId: string, listener: EventListener): Promise<{ snapshot: ServerEvent; close: () => void } | null>;
}

export interface ViewingDependencies {
  views: ViewSource;
  credentials: ViewingCredentials;
  limits?: Partial<ViewingLimits>;
}

// Close codes carry no reason text, so nothing about the input is reflected.
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const TRY_AGAIN_LATER = 1013;

export function registerWebSocketBoundary(app: FastifyInstance, dependencies: ViewingDependencies): void {
  const limits = { ...DEFAULT_VIEWING_LIMITS, ...dependencies.limits };
  const connectionsByChannel = new Map<string, number>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    if (request.url?.split('?')[0] !== '/ws') {
      rejectUpgrade(socket, '404 Not Found', 'Not found.\n');
    } else if (request.headers.origin !== OVERLAY_ORIGIN) {
      rejectUpgrade(socket, '403 Forbidden', 'Forbidden.\n');
    } else if (webSocketServer.clients.size >= limits.maxConnections) {
      rejectUpgrade(socket, '503 Service Unavailable', 'Too many connections.\n');
    } else {
      webSocketServer.handleUpgrade(request, socket, head, (viewer) => acceptViewer(viewer));
    }
  };

  const acceptViewer = (viewer: WebSocket): void => {
    let channelId: string | null = null;
    let view: { close: () => void } | null = null;
    let receivedFirstMessage = false;
    let snapshotSent = false;
    let closed = false;
    let alive = true;
    const pending: ServerEvent[] = [];

    const send = (event: ServerEvent): void => {
      if (viewer.readyState !== WebSocket.OPEN) return;
      // A client that falls too far behind is dropped; it receives a fresh snapshot on reconnection.
      if (viewer.bufferedAmount > limits.maxBufferedBytes) {
        viewer.terminate();
        return;
      }
      viewer.send(JSON.stringify(event));
    };
    // Events that arrive while the snapshot is being sent are queued and sent right after it.
    const listener: EventListener = (event) => {
      if (snapshotSent) send(event);
      else pending.push(event);
    };

    const authTimer = setTimeout(() => viewer.close(POLICY_VIOLATION), limits.authTimeoutMs);
    const heartbeat = setInterval(() => {
      if (!alive) {
        viewer.terminate();
        return;
      }
      alive = false;
      viewer.ping();
    }, limits.heartbeatIntervalMs);

    const authenticate = async (data: RawData, isBinary: boolean): Promise<void> => {
      const parsed = clientMessageSchema.safeParse(isBinary ? null : parseJson(data));
      if (!parsed.success ||
          !dependencies.credentials.verify(parsed.data.payload.channelId, parsed.data.payload.viewingCredential)) {
        viewer.close(POLICY_VIOLATION);
        return;
      }
      const requested = parsed.data.payload.channelId;
      const current = connectionsByChannel.get(requested) ?? 0;
      if (current >= limits.maxConnectionsPerChannel) {
        viewer.close(TRY_AGAIN_LATER);
        return;
      }
      connectionsByChannel.set(requested, current + 1);
      channelId = requested;
      const opened = await dependencies.views.openView(requested, listener);
      if (closed) {
        opened?.close();
        return;
      }
      if (!opened) {
        viewer.close(INTERNAL_ERROR);
        return;
      }
      view = opened;
      send(opened.snapshot);
      snapshotSent = true;
      for (const event of pending.splice(0)) send(event);
    };

    viewer.on('pong', () => { alive = true; });
    viewer.on('message', (data, isBinary) => {
      // Only one authentication message is accepted; anything else closes the connection.
      if (receivedFirstMessage) {
        viewer.close(POLICY_VIOLATION);
        return;
      }
      receivedFirstMessage = true;
      clearTimeout(authTimer);
      void authenticate(data, isBinary).catch(() => viewer.close(INTERNAL_ERROR));
    });
    viewer.on('error', () => viewer.terminate());
    viewer.on('close', () => {
      closed = true;
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      view?.close();
      if (channelId !== null) {
        const remaining = (connectionsByChannel.get(channelId) ?? 1) - 1;
        if (remaining > 0) connectionsByChannel.set(channelId, remaining);
        else connectionsByChannel.delete(channelId);
      }
    });
  };

  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', async () => {
    app.server.off('upgrade', onUpgrade);
    for (const viewer of webSocketServer.clients) viewer.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  });
}

function parseJson(data: RawData): unknown {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

// Never echo the requested URL, query parameters, headers, or credentials.
function rejectUpgrade(socket: Duplex, status: string, body: string): void {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`,
    () => socket.destroy(),
  );
}
