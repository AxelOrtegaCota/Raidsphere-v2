/**
 * Local visual fixtures for the real overlay entry point. No server or Twitch calls.
 * Run only after approval: node overlay/test/control-room-preview.mjs
 * This preview is not part of the production entry point or build.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

function installFixtures() {
  const scenarios = ['logged-out', 'offline', 'live-empty', 'manual-empty', 'manual-three', 'auto', 'auto-prepared',
    'winner', 'winner-live', 'voting', 'queued', 'cancelled', 'rejected', 'uncertain', 'request-uncertain',
    'status-error', 'forbidden', 'logout-error', 'logout-partial', 'logout-lost-response', 'obs', 'obs-idle'];
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'live-empty';
  if (!scenarios.includes(scenario)) throw new Error('Unknown local preview scenario.');
  const obs = scenario === 'obs' || scenario === 'obs-idle';
  params.set('mode', obs ? 'obs' : 'interactive');
  history.replaceState(null, '', `${location.pathname}?${params}${obs ? '#channel=1001&cred=synthetic-preview-viewing-only' : ''}`);
  const simulated = scenario !== 'winner-live';
  const now = Date.now();
  const names = ['MapleArcade', 'LunaPlays', 'Northlight', 'CosmicFox', 'PaperKite', 'BlueComet', 'SunnyByte'];
  const languages = ['en', 'es', 'pt', 'fr', 'de', 'ja', 'ko'];
  const candidates = names.map((displayName, index) => ({
    streamerId: String(2002 + index), login: displayName.toLowerCase(), displayName, avatarUrl: null,
    language: languages[index], illustrativeCountry: null, viewers: 70 + index * 15,
    gameName: 'Just Chatting', title: 'A synthetic live stream for local UI checks',
  }));
  // Only Auto fixtures use the tier ladder; existing Manual, OBS and Logout fixtures stay intact.
  const autoLadder = candidates.map((candidate, index) => ({
    ...candidate, viewers: [5, 30, 75, 150, 375, 750, 1_500][index],
  }));
  const makeSession = (pool, status = 'chosen', mode = 'manual') => ({
    sessionId: 'synthetic-preview-session', fromStreamerId: '1001', mode, status, candidates: pool,
    votes: mode === 'chat' ? { en: 1, es: 2 } : {}, createdAtMs: now - 10_000,
    votingEndsAtMs: status === 'voting' ? Date.now() + 30_000 : null,
    chosenCandidate: status === 'voting' ? null : pool[Math.min(1, pool.length - 1)],
  });
  let roulette = ['winner', 'winner-live', 'queued', 'cancelled', 'rejected', 'uncertain', 'obs'].includes(scenario)
    ? makeSession(candidates.slice(0, 3)) : scenario === 'voting' ? makeSession(candidates.slice(0, 3), 'voting', 'chat') : null;
  if (roulette && ['queued', 'cancelled', 'rejected', 'uncertain'].includes(scenario)) {
    roulette.status = { queued: 'raid_pending', cancelled: 'cancelled', rejected: 'failed', uncertain: 'unknown' }[scenario];
    if (scenario === 'queued') Object.assign(roulette, { raidRequestedAtMs: now - 5_000, estimatedCountdownSeconds: 90 });
  }
  let prepared = null;
  let authenticated = !['logged-out', 'forbidden'].includes(scenario);
  const requests = [];
  const originalFetch = window.fetch.bind(window);
  const json = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }));
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.origin);
    if (url.origin !== location.origin) throw new TypeError('External requests are disabled in the fixture preview.');
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    if (path === '/health') return json({ mode: simulated ? 'simulation' : 'live', translation: 'simulated' });
    if (path === '/api/control/status') {
      if (scenario === 'forbidden') return json({ error: 'Synthetic forbidden session.' }, 403);
      if (!authenticated) return json({ error: 'Synthetic unauthenticated session.' }, 401);
      if (scenario === 'status-error') return json({ error: 'Synthetic status failure.' }, 503);
      return json({ channelId: '1001', login: 'fixturecaster', isLive: scenario !== 'offline', viewers: scenario === 'offline' ? 0 : 100, simulated, roulette });
    }
    if (path === '/api/test-helix') return json({
      streams: candidates.slice(0, 3).map((candidate) => ({
        id: candidate.streamerId, login: candidate.login, displayName: candidate.displayName, game: candidate.gameName,
        title: candidate.title, viewers: candidate.viewers, language: candidate.language, isLive: true,
        thumbnailUrl: '', profileImageUrl: '',
      })), search_results: [],
    });
    if (path === '/api/categories') return json({ categories: [] });
    if (path === '/auth/logout' && method === 'POST') {
      requests.push({ method, path, body: {} });
      if (!authenticated) return json({ error: 'Not authenticated.' }, 401);
      if (scenario === 'logout-error') return json({ error: 'Synthetic logout failure.' }, 503);
      authenticated = false;
      if (scenario === 'logout-lost-response') throw new TypeError('Synthetic lost logout response.');
      return json({
        message: 'Logged out', authenticated: false, integrationCleanup: 'confirmed',
        twitchRevocation: scenario === 'logout-partial' ? 'unconfirmed' : 'confirmed',
      });
    }
    if (path.startsWith('/api/control/') && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      requests.push({ method, path, body });
      if (!authenticated) return json({ error: 'Synthetic authentication rejection.' }, 401);
      if (scenario === 'offline') return json({ error: 'Your source stream is offline. A raid requires a live source stream.' }, 409);
      if (path === '/api/control/prepare') {
        const pool = body.mode === 'auto' ? autoLadder.slice(0, body.count) : candidates.filter((candidate) => body.candidateIds?.includes(candidate.streamerId));
        prepared = {
          poolId: '00000000-0000-4000-8000-000000000001', mode: body.mode, candidates: pool,
          sourceViewers: 100, minViewers: 0, maxViewers: 1_000_000, discoveryLimited: false, expiresAtMs: Date.now() + 120_000,
        };
        return json(prepared);
      }
      if (path === '/api/control/spin') {
        if (!prepared?.candidates.length) return json({ error: 'Prepare candidates first.' }, 409);
        roulette = makeSession(prepared.candidates, 'chosen', prepared.mode);
      } else if (path === '/api/control/raid') {
        if (scenario === 'request-uncertain') throw new TypeError('Synthetic lost response.');
        if (body.toStreamerId) {
          const target = candidates.find((candidate) => candidate.streamerId === body.toStreamerId);
          if (!target) return json({ error: 'Unknown synthetic destination.' }, 409);
          roulette = makeSession([target], 'chosen', 'direct');
        }
        if (!roulette) return json({ error: 'No synthetic session.' }, 409);
        roulette = { ...roulette, status: 'raid_pending', raidRequestedAtMs: Date.now(), estimatedCountdownSeconds: 90 };
      } else if (path === '/api/control/cancel') {
        if (!roulette) return json({ error: 'No synthetic session.' }, 409);
        roulette = { ...roulette, status: 'cancelled' };
      } else return json({ error: 'Unsupported fixture action.' }, 404);
      return json({ roulette, simulated });
    }
    if (path.startsWith('/api/') || path.startsWith('/auth/')) return json({ error: 'Unavailable in the local fixture preview.' }, 404);
    return originalFetch(input, init);
  };
  // The discovery panel's Open Stream action must never navigate to Twitch here.
  window.open = () => null;

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class PreviewSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    constructor(url, protocols) {
      const target = new URL(url, location.href);
      if (target.hostname !== '127.0.0.1' || target.port !== location.port) throw new TypeError('External sockets are disabled in the fixture preview.');
      if (target.pathname !== '/ws') return new NativeWebSocket(url, protocols);
      super();
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(value) {
      const auth = JSON.parse(value);
      if (auth.type !== 'auth' || auth.payload.channelId !== '1001') return;
      const event = (type, payload, sequence) => ({
        version: 1, type, eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        channelId: '1001', occurredAtMs: Date.now(), sequence, payload,
      });
      const translationWindow = scenario === 'obs' ? {
        channelId: '1001', status: 'active', targetLanguage: 'es', activatedAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 600_000,
      } : null;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event('state:snapshot', { roulette, translationWindow }, 1)) }));
        if (scenario === 'obs') {
          const text = 'Hello from the fixture chat.';
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event('translate:bubble', {
            messageId: 'synthetic-preview-message', userId: '3003', displayName: 'PreviewViewer', original: text,
            fragments: [{ type: 'text', text }], fromLanguage: 'en', toLanguage: 'es', illustrativeCountry: null,
            receivedAtMs: Date.now(), status: 'completed', translated: 'Hola desde el chat de prueba.',
          }, 2)) }));
        }
      });
    }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
  };

  const visible = (selector) => {
    const node = document.querySelector(selector);
    return Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  };
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
  const preview = {
    scenario, scenarios, requests, ready: false, fixtureOnly: true,
    inspect() {
      const card = rect('.roulette-card');
      const discovery = rect('.search-panel');
      const actions = [...document.querySelectorAll('.roulette-actions button')];
      return {
        scenario, ready: preview.ready, viewport: [innerWidth, innerHeight],
        status: document.querySelector('#control-status')?.textContent,
        pageOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        cardOverlapsDiscovery: visible('.roulette-card') && discovery && card ? card.right > discovery.left : false,
        actionsWithinViewport: !visible('.roulette-card') || actions.every((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
        }),
        primaryActions: actions.filter((button) => button.classList.contains('is-primary')).map((button) => button.id),
        cancelVisible: visible('#cancel-raid'), autoCountVisible: visible('#auto-count'),
        logoutVisible: visible('#logout'), logoutDisabled: document.querySelector('#logout')?.disabled,
        headlineVisible: visible('#session-status'), roulettePanelVisible: visible('#roulette'),
        bubblesVisible: visible('#bubbles') && Boolean(document.querySelector('#bubbles')?.childElementCount),
        controlRequests: requests.length,
      };
    },
  };
  window.__controlRoomPreview = preview;
  document.addEventListener('DOMContentLoaded', () => {
    void (async () => {
      const waitFor = async (condition) => {
        const deadline = performance.now() + 15_000;
        while (!condition()) {
          if (performance.now() > deadline) throw new Error('The fixture UI did not become ready.');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };
      if (obs) {
        await waitFor(() => document.querySelector('#connection-status')?.textContent === 'Live, read-only.');
      } else {
        await waitFor(() => {
          const text = document.querySelector('#control-status')?.textContent;
          return text && text !== 'Checking your Twitch session…';
        });
        if (params.get('view') === 'roulette' || ['manual-empty', 'manual-three', 'auto', 'auto-prepared', 'winner', 'winner-live', 'queued', 'cancelled', 'rejected', 'uncertain', 'voting'].includes(scenario)) {
          document.querySelector('#view-roulette').click();
        }
        if (scenario === 'manual-three') {
          await waitFor(() => document.querySelectorAll('.candidate-item').length === 3);
          for (let index = 0; index < 3; index += 1) {
            document.querySelectorAll('.candidate-item')[index].click();
            document.querySelector('.btn-add').click();
            document.querySelector('.detail-back').click();
          }
        }
        if (scenario === 'auto' || scenario === 'auto-prepared') document.querySelector('#mode-auto').click();
        if (scenario === 'auto-prepared') {
          const count = document.querySelector('#auto-count');
          count.value = '7'; count.dispatchEvent(new Event('change'));
          document.querySelector('#prepare-roulette').click();
          await waitFor(() => document.querySelector('#candidate-count')?.textContent === '7 channels');
        }
      }
      preview.ready = true;
      document.dispatchEvent(new Event('control-room-preview-ready'));
    })().catch((error) => { preview.error = error.message; });
  }, { once: true });
}

const port = 5174;
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false, envDir: false,
  cacheDir: 'node_modules/.vite-control-room-preview',
  server: {
    host: '127.0.0.1', port, strictPort: true, hmr: false,
    headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:5174; worker-src 'self' blob:; object-src 'none'; base-uri 'none'" },
  },
  plugins: [{
    name: 'control-room-local-fixtures',
    transformIndexHtml: () => [{ tag: 'script', children: `(${installFixtures.toString()})();`, injectTo: 'head-prepend' }],
  }],
});
await server.listen();
console.log(`Local fixture preview: http://127.0.0.1:${port}/?scenario=live-empty`);
console.log('Target viewports: 1366x768 and 1920x1080. Change ?scenario=manual-three, auto, auto-prepared, winner, or obs.');
console.log('Inspect geometry and readiness with window.__controlRoomPreview.inspect(). No environment files or live integrations are loaded.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
