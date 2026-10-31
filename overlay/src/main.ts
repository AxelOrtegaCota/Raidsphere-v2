import Globe from 'globe.gl';
import { connectToChannel, readOverlayTarget } from './connection';
import type { ConnectionStatus } from './connection';
import { EMPTY_SCENE, globeScene, interpolateView } from './globe-session';
import type { CameraView, GlobeScene } from './globe-session';
import { coarseCountryPoint } from './location';
import { readOverlayMode, showsSimulationLabel } from './overlay-mode';
import { describeRoulettePanel, renderRoulettePanel } from './roulette-panel';
import { createSearchPanel } from './search-panel';
import { createTranslationLayer } from './translation-bubbles';
import { applyTranslationEvent, initialTranslationView, pruneTranslationView } from './translation-view';
import { applyEvent, describeView, initialViewState, needsTick } from './view-state';
import './styles.css';

const container = document.querySelector<HTMLElement>('#globe');
const headline = document.querySelector<HTMLElement>('#headline');
const detail = document.querySelector<HTMLElement>('#detail');
const status = document.querySelector<HTMLElement>('#connection-status');
const badge = document.querySelector<HTMLElement>('.badge');
const locateCountry = document.querySelector<HTMLButtonElement>('#locate-country');
const locationStatus = document.querySelector<HTMLElement>('#location-status');
const translationWindow = document.querySelector<HTMLElement>('#translation-window');
const bubbleList = document.querySelector<HTMLOListElement>('#bubbles');
const roulettePanel = document.querySelector<HTMLElement>('#roulette');
const app = document.querySelector<HTMLElement>('#app');

if (!container || !headline || !detail || !status || !badge || !locateCountry || !locationStatus ||
    !translationWindow || !bubbleList || !roulettePanel || !app) {
  throw new Error('The overlay is missing its required elements.');
}

const target = readOverlayTarget(window.location, window.history);
const mode = readOverlayMode(window.location.search, target !== null);
document.documentElement.dataset.mode = mode;
const apiBaseUrl = window.location.origin;

// The label is removed only when the server positively reports live mode.
void fetch(`${apiBaseUrl}/health`, { cache: 'no-store' })
  .then((response) => response.json())
  .then((health: unknown) => { badge.hidden = !showsSimulationLabel(health); })
  .catch(() => { badge.hidden = false; });

// Discovery never appears in the OBS scene, which is what viewers of the stream see.
if (mode === 'interactive') startDiscovery(app);

let applyScene: (scene: GlobeScene) => void = () => undefined;
try {
  applyScene = startGlobe(container, mode, { button: locateCountry, status: locationStatus });
} catch {
  container.hidden = true;
  locationStatus.textContent = '3D rendering is unavailable; the overlay remains connected.';
}

// Text only: event data comes from the network and is never interpreted as HTML.
let view = initialViewState;
let translationView = initialTranslationView;
const translations = createTranslationLayer(translationWindow, bubbleList);
const renderTranslations = (): void => {
  const nowMs = Date.now();
  translationView = pruneTranslationView(translationView, nowMs);
  translations.render(translationView, nowMs);
};
const render = (): void => {
  const text = describeView(view, Date.now());
  headline.textContent = text.headline;
  detail.textContent = text.detail;
};
const renderSession = (): void => {
  render();
  renderRoulettePanel(roulettePanel, describeRoulettePanel(view));
  applyScene(globeScene(view));
};

const describeStatus = (connection: ConnectionStatus): string => {
  switch (connection.kind) {
    case 'connecting': return 'Connecting to the RaidSphere server.';
    case 'live': return 'Live, read-only.';
    case 'reconnecting': return `Connection lost. Retrying in ${Math.round(connection.retryInMs / 1_000)} s.`;
    case 'rejected': return 'Viewing credential rejected. Copy the overlay URL again from the server terminal.';
  }
};

if (target) {
  const stop = connectToChannel(target, {
    onEvent: (event) => {
      view = applyEvent(view, event);
      translationView = applyTranslationEvent(translationView, event, Date.now());
      renderSession();
      renderTranslations();
    },
    onStatus: (connection) => { status.textContent = describeStatus(connection); },
  });
  const ticker = window.setInterval(() => { if (needsTick(view)) render(); }, 1_000);
  // Fine-grained only while something is shown, so bubbles fade on time.
  const translationTicker = window.setInterval(() => {
    if (translationView.window || translationView.bubbles.length > 0) renderTranslations();
  }, 250);
  window.addEventListener('pagehide', () => {
    window.clearInterval(ticker);
    window.clearInterval(translationTicker);
    stop();
  }, { once: true });
  renderSession();
} else {
  // No credential: standalone mode. The overlay works for discovery without a roulette session.
  status.textContent = 'Standalone mode — use the search panel to discover streams.';
}

// Returns the function that applies session scenes. OBS mode renders only while something
// moves; interactive mode keeps the rotating, draggable globe.
function startGlobe(
  element: HTMLElement,
  overlayMode: typeof mode,
  location: { button: HTMLButtonElement; status: HTMLElement },
): (scene: GlobeScene) => void {
  const interactive = overlayMode === 'interactive';
  const globe = Globe({ animateIn: false })(element)
    .backgroundColor('rgba(0, 0, 0, 0)')
    .backgroundImageUrl(interactive ? '/textures/night-sky.png' : null)
    .globeImageUrl('/textures/earth-night.jpg')
    .showGraticules(false)
    .showAtmosphere(true)
    .atmosphereColor('#6f8dff')
    .atmosphereAltitude(0.2)
    .pointsData([])
    .pointLat('lat')
    .pointLng('lng')
    .pointColor('color')
    .pointRadius('radius')
    .pointAltitude(0.035)
    .arcsData([])
    .arcColor('color')
    .arcStroke(0.7)
    .arcAltitudeAutoScale(0.45)
    .arcDashLength(0.45)
    .arcDashGap(0.2)
    .arcDashAnimateTime(1_800)
    .width(element.clientWidth)
    .height(element.clientHeight);

  const controls = globe.controls();
  controls.enabled = interactive;
  controls.autoRotate = interactive;
  controls.autoRotateSpeed = 0.3;
  globe.pointOfView({ lat: 18, lng: -30, altitude: 2.35 });

  // Property updates and camera moves apply asynchronously, so render briefly before pausing.
  let animated = false;
  let settleTimer: number | undefined;
  let pauseAtMs = 0;
  // Never brings a pending pause forward, so a short render cannot cut a camera transition.
  const renderFor = (durationMs: number): void => {
    globe.resumeAnimation();
    window.clearTimeout(settleTimer);
    if (interactive || animated) return;
    pauseAtMs = Math.max(pauseAtMs, Date.now() + durationMs);
    settleTimer = window.setTimeout(() => globe.pauseAnimation(), pauseAtMs - Date.now());
  };

  // Moves the camera frame by frame with instant updates, which globe.gl applies reliably.
  let flight: number | undefined;
  const flyTo = (to: CameraView, durationMs: number): void => {
    window.cancelAnimationFrame(flight ?? 0);
    const from = globe.pointOfView();
    const startedAtMs = performance.now();
    renderFor(durationMs + 300);
    const step = (nowMs: number): void => {
      const k = (nowMs - startedAtMs) / durationMs;
      globe.pointOfView(interpolateView(from, to, k));
      if (k < 1) flight = window.requestAnimationFrame(step);
    };
    flight = window.requestAnimationFrame(step);
  };

  globe.onGlobeReady(() => renderFor(500));
  const resize = new ResizeObserver(() => {
    globe.width(element.clientWidth).height(element.clientHeight);
    renderFor(500);
  });
  resize.observe(element);

  let scene = EMPTY_SCENE;
  let userPoint: { lat: number; lng: number; color: string; radius: number } | null = null;
  const draw = (): void => {
    globe.pointsData(userPoint ? [...scene.points, userPoint] : scene.points).arcsData(scene.arcs);
  };

  if (interactive) {
    element.addEventListener('pointerdown', () => { controls.autoRotateSpeed = 0.3; });
    startLocation(globe, location, (point) => {
      userPoint = { ...point, color: '#ffd166', radius: 0.52 };
      controls.autoRotate = false;
      draw();
    }, (view) => flyTo(view, 1_400));
  }

  window.addEventListener('pagehide', () => {
    window.clearTimeout(settleTimer);
    window.cancelAnimationFrame(flight ?? 0);
    resize.disconnect();
    globe.pauseAnimation();
  }, { once: true });

  return (next) => {
    const focusChanged = JSON.stringify(next.focus) !== JSON.stringify(scene.focus);
    scene = next;
    animated = next.animated;
    draw();
    if (interactive && next.focus) controls.autoRotate = false;
    renderFor(1_500);
    if (focusChanged && next.focus) flyTo(next.focus, 1_200);
  };
}

function startLocation(
  globe: ReturnType<typeof Globe>,
  { button: locateCountry, status: locationStatus }: { button: HTMLButtonElement; status: HTMLElement },
  onLocated: (point: { lat: number; lng: number }) => void,
  onFly: (view: CameraView) => void,
): void {
  let located = false;
  const locate = (point: { lat: number; lng: number }): void => {
    located = true;
    onLocated(point);
    onFly({ ...point, altitude: 1.7 });
    locateCountry.textContent = 'Country located';
    locateCountry.disabled = true;
    locationStatus.textContent = 'Approximate area only · precise coordinates discarded';
  };
  if (!('geolocation' in navigator)) {
    locateCountry.disabled = true;
    locationStatus.textContent = 'Country location is not available in this browser.';
    return;
  }
  locationStatus.textContent = 'Click to share your country area (optional)';
  locateCountry.addEventListener('click', () => {
    if (located) return;
    locateCountry.disabled = true;
    locationStatus.textContent = 'Waiting for browser permission…';
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => locate(coarseCountryPoint(coords)),
      () => {
        locateCountry.disabled = false;
        locationStatus.textContent = 'Location was not shared. The overlay still works normally.';
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 3_600_000 },
    );
  });
}

// Discovery belongs to the broadcaster's browser tab, never to the OBS scene.
function startDiscovery(root: HTMLElement): void {
  const searchPanel = createSearchPanel(root, {
    apiBaseUrl,
    isOverlay: true,
    onRaid: (candidate) => {
      // Real raids are not wired to discovery yet; nothing is requested.
      window.alert(`Starting a raid to ${candidate.displayName} is not available yet.`);
    },
  });
  void (async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/auth/status`, { credentials: 'include' });
      const data: unknown = await response.json();
      const authenticated = typeof data === 'object' && data !== null && 'authenticated' in data && data.authenticated === true;
      const login = authenticated && 'user' in data && typeof data.user === 'string' ? data.user : undefined;
      // Live status is not checked through Helix yet.
      searchPanel.updateUserStatus(authenticated ? { authenticated: true, isLive: false, ...(login ? { login } : {}) } : { authenticated: false, isLive: false });
    } catch {
      searchPanel.updateUserStatus({ authenticated: false, isLive: false });
    }
  })();
}
