import { describe, expect, it } from 'vitest';
import { readOverlayTarget, webSocketUrl } from '../src/connection.js';

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
