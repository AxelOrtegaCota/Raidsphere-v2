import Globe from 'globe.gl';
import { connectToChannel, readOverlayTarget } from './connection';
import type { ConnectionStatus } from './connection';
import { coarseCountryPoint } from './location';
import { applyEvent, describeView, initialViewState, needsTick } from './view-state';
import './styles.css';

const container = document.querySelector<HTMLElement>('#globe');
const headline = document.querySelector<HTMLElement>('#headline');
const detail = document.querySelector<HTMLElement>('#detail');
const status = document.querySelector<HTMLElement>('#connection-status');
const locateCountry = document.querySelector<HTMLButtonElement>('#locate-country');
const locationStatus = document.querySelector<HTMLElement>('#location-status');

if (!container || !headline || !detail || !status || !locateCountry || !locationStatus) {
  throw new Error('The overlay is missing its required elements.');
}

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

  globe.controls().enabled = false;
  globe.pointOfView({ lat: 18, lng: -30, altitude: 2.35 });

  // Property updates and camera transitions render briefly, then pause to keep OBS GPU usage bounded.
  const SETTLE_MS = 250;
  let settleTimer: number | undefined;
  const renderBriefly = (durationMs = SETTLE_MS): void => {
    globe.resumeAnimation();
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => globe.pauseAnimation(), durationMs);
  };

  globe.onGlobeReady(renderBriefly);
  const resize = new ResizeObserver(() => {
    globe.width(container.clientWidth).height(container.clientHeight);
    renderBriefly();
  });
  resize.observe(container);

  if (!('geolocation' in navigator)) {
    locateCountry.disabled = true;
    locationStatus.textContent = 'Country location is not available in this browser.';
  } else {
    locateCountry.addEventListener('click', () => {
      locateCountry.disabled = true;
      locationStatus.textContent = 'Waiting for browser permission…';
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        const point = coarseCountryPoint(coords);
        globe.pointsData([{ ...point, color: '#ffd166' }]);
        globe.pointOfView({ ...point, altitude: 1.7 }, 1_400);
        renderBriefly(1_650);
        locateCountry.textContent = 'Country area located';
        locationStatus.textContent = 'Approximate area only · precise coordinates discarded';
      }, () => {
        locateCountry.disabled = false;
        locationStatus.textContent = 'Location was not shared. The overlay still works normally.';
      }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 3_600_000 });
    });
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

const target = readOverlayTarget(window.location, window.history);
if (target) {
  const stop = connectToChannel(target, {
    onEvent: (event) => {
      view = applyEvent(view, event);
      render();
    },
    onStatus: (connection) => { status.textContent = describeStatus(connection); },
  });
  const ticker = window.setInterval(() => { if (needsTick(view)) render(); }, 1_000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(ticker);
    stop();
  }, { once: true });
  render();
} else {
  status.textContent = 'No viewing credential. Open the overlay URL printed by the RaidSphere server.';
}
