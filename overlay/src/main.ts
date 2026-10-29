import Globe from 'globe.gl';
import { connectToChannel, readOverlayTarget } from './connection';
import type { ConnectionStatus } from './connection';
import { coarseCountryPoint } from './location';
import { applyEvent, describeView, initialViewState, needsTick } from './view-state';
import { createSearchPanel } from './search-panel';
import { createTranslationLayer } from './translation-bubbles';
import { applyTranslationEvent, initialTranslationView, pruneTranslationView } from './translation-view';
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

if (!container || !headline || !detail || !status || !locateCountry || !locationStatus || !translationWindow || !bubbleList) {
  throw new Error('The overlay is missing its required elements.');
}

// Hide simulation badge when authenticated (credential present means authenticated)
const target = readOverlayTarget(window.location, window.history);
if (target?.credential && badge) {
  badge.style.display = 'none';
}

// Determine API base URL
const apiBaseUrl = window.location.origin;

// Create search panel (always open in overlay)
const app = document.querySelector<HTMLElement>('#app')!;
const searchPanel = createSearchPanel(app, {
  apiBaseUrl,
  isOverlay: true, // Always open in overlay
  onRaid: (candidate) => {
    console.log('Raid requested for:', candidate.login);
    // TODO: Call raid API
    alert(`Raid to ${candidate.displayName} would start here (not implemented yet)`);
  },
});

// Check user status and update panel
const checkUserStatus = async () => {
  try {
    const response = await fetch(`${apiBaseUrl}/auth/status`, { credentials: 'include' });
    const data = await response.json();
    
    if (data.authenticated) {
      // Check if user is live
      const meResponse = await fetch(`${apiBaseUrl}/auth/me`, { credentials: 'include' });
      const meData = await meResponse.json();
      
      // For now assume not live (would need to check Helix)
      searchPanel.updateUserStatus({
        authenticated: true,
        isLive: false, // TODO: Check via Helix if user is streaming
        login: data.user,
      });
    } else {
      searchPanel.updateUserStatus({ authenticated: false, isLive: false });
    }
  } catch {
    searchPanel.updateUserStatus({ authenticated: false, isLive: false });
  }
};
checkUserStatus();

let userLocationPoint: { lat: number; lng: number } | null = null;

try {
  const globe = Globe({ animateIn: false })(container)
    .backgroundColor('rgba(0, 0, 0, 0)')
    .backgroundImageUrl('/textures/night-sky.png')
    .globeImageUrl('/textures/earth-night.jpg')
    .showGraticules(false)
    .showAtmosphere(true)
    .atmosphereColor('#6f8dff')
    .atmosphereAltitude(0.2)
    .pointsData([])
    .pointLat('lat')
    .pointLng('lng')
    .pointColor('color')
    .pointAltitude(0.035)
    .pointRadius(0.52)
    .width(container.clientWidth)
    .height(container.clientHeight);

  // Enable interactive controls - user can rotate/zoom the globe
  globe.controls().enableZoom = true;
  globe.controls().enableRotate = true;
  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.3;
  globe.pointOfView({ lat: 18, lng: -30, altitude: 2.35 });

  // Keep animation running for interactivity, but throttle when idle
  const SETTLE_MS = 3000;
  let settleTimer: number | undefined;
  const renderBriefly = (durationMs = SETTLE_MS): void => {
    globe.resumeAnimation();
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      // Keep auto-rotate but reduce frame rate when not interacting
      globe.controls().autoRotateSpeed = 0.15;
    }, durationMs);
  };

  // Resume full speed on interaction
  container.addEventListener('pointerdown', () => {
    globe.controls().autoRotateSpeed = 0.3;
    renderBriefly();
  });

  globe.onGlobeReady(renderBriefly);
  const resize = new ResizeObserver(() => {
    globe.width(container.clientWidth).height(container.clientHeight);
    renderBriefly();
  });
  resize.observe(container);

  const setUserLocation = (point: { lat: number; lng: number }) => {
    userLocationPoint = point;
    globe.pointsData([{ ...point, color: '#ffd166' }]);
    globe.controls().autoRotate = false;
    globe.pointOfView({ ...point, altitude: 1.7 }, 1_400);
    renderBriefly(1_650);
    locateCountry.textContent = 'Country located';
    locateCountry.disabled = true;
    locationStatus.textContent = 'Approximate area only · precise coordinates discarded';
  };

  // Auto-detect location on load if geolocation available
  if ('geolocation' in navigator) {
    locationStatus.textContent = 'Detecting location…';
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = coarseCountryPoint(coords);
        setUserLocation(point);
      },
      () => {
        // Auto-detect failed silently, user can still click button
        locationStatus.textContent = 'Click to share your country area (optional)';
        locateCountry.disabled = false;
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 3_600_000 }
    );

    locateCountry.addEventListener('click', () => {
      if (userLocationPoint) return; // Already located
      locateCountry.disabled = true;
      locationStatus.textContent = 'Waiting for browser permission…';
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          const point = coarseCountryPoint(coords);
          setUserLocation(point);
        },
        () => {
          locateCountry.disabled = false;
          locationStatus.textContent = 'Location was not shared. The overlay still works normally.';
        },
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 3_600_000 }
      );
    });
  } else {
    locateCountry.disabled = true;
    locationStatus.textContent = 'Country location is not available in this browser.';
  }

  window.addEventListener('pagehide', () => {
    window.clearTimeout(settleTimer);
    resize.disconnect();
    globe.pauseAnimation();
  }, { once: true });
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
      render();
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
  render();
} else {
  status.textContent = 'No viewing credential. Open the overlay URL printed by the RaidSphere server.';
}
