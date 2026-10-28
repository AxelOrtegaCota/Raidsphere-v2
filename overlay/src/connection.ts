import { PROTOCOL_VERSION, serverEventSchema } from '@raidsphere/shared';
import type { ServerEvent } from '@raidsphere/shared';

// Read-only WebSocket client for the overlay (D2-11 rules 7 and 8). It never sends commands.

// Matches the server's default loopback port; change it if the server runs on another PORT.
export const SERVER_URL = 'ws://127.0.0.1:3000/ws';

const POLICY_VIOLATION = 1008;
const MAX_RETRY_MS = 30_000;

export interface OverlayTarget {
  channelId: string;
  credential: string;
}

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; retryInMs: number }
  | { kind: 'rejected' };

// Reads the channel from the path and the credential from the fragment, then removes the
// fragment from the address bar. The credential stays only in memory.
export function readOverlayTarget(location: Location, history: History): OverlayTarget | null {
  const channelId = /^\/([A-Za-z0-9_]{1,25})\/overlay\/?$/.exec(location.pathname)?.[1];
  const credential = new URLSearchParams(location.hash.slice(1)).get('cred');
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return channelId && credential ? { channelId, credential } : null;
}

export function connectToChannel(
  target: OverlayTarget,
  handlers: { onEvent: (event: ServerEvent) => void; onStatus: (status: ConnectionStatus) => void },
): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = (): void => {
    handlers.onStatus({ kind: 'connecting' });
    const current = new WebSocket(SERVER_URL);
    socket = current;
    current.addEventListener('open', () => {
      current.send(JSON.stringify({
        version: PROTOCOL_VERSION, type: 'auth',
        payload: { channelId: target.channelId, viewingCredential: target.credential },
      }));
    });
    current.addEventListener('message', (message) => {
      if (typeof message.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      // Network messages are untrusted: only valid events for this channel are applied.
      const parsed = serverEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.channelId !== target.channelId) return;
      if (parsed.data.type === 'state:snapshot') {
        attempt = 0;
        handlers.onStatus({ kind: 'live' });
      }
      handlers.onEvent(parsed.data);
    });
    current.addEventListener('close', (event) => {
      if (stopped) return;
      // A rejected credential will not become valid by retrying (usually the server restarted).
      if (event.code === POLICY_VIOLATION) {
        handlers.onStatus({ kind: 'rejected' });
        return;
      }
      const retryInMs = Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt);
      attempt += 1;
      handlers.onStatus({ kind: 'reconnecting', retryInMs });
      retryTimer = setTimeout(open, retryInMs);
    });
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    socket?.close();
  };
}
