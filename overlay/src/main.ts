import Globe from 'globe.gl';
import { connectToChannel, readOverlayTarget } from './connection';
import type { ConnectionStatus } from './connection';
import { applyEvent, describeView, initialViewState, needsTick } from './view-state';
import './styles.css';

const container = document.querySelector<HTMLElement>('#globe');
const headline = document.querySelector<HTMLElement>('#headline');
const detail = document.querySelector<HTMLElement>('#detail');
const status = document.querySelector<HTMLElement>('#connection-status');

if (!container || !headline || !detail || !status) {
  throw new Error('The overlay is missing its required elements.');
}

try {
  // A procedural surface avoids external textures and geographic requests.
  const globe = Globe({ animateIn: false })(container)
    .backgroundColor('rgba(0, 0, 0, 0)')
    .showGraticules(true)
    .showAtmosphere(true)
    .atmosphereColor('#a78bfa')
    .width(container.clientWidth)
    .height(container.clientHeight);

  // Disable controls first so the point of view orients the camera directly.
  globe.controls().enabled = false;
  globe.pointOfView({ lat: 18, lng: -30, altitude: 2.4 });

  // Property updates are applied asynchronously, so render briefly before suspending.
  const SETTLE_MS = 250;
  let settleTimer: number | undefined;
  const renderBriefly = (): void => {
    globe.resumeAnimation();
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => globe.pauseAnimation(), SETTLE_MS);
  };

  globe.onGlobeReady(renderBriefly);
  const resize = new ResizeObserver(() => {
    globe.width(container.clientWidth).height(container.clientHeight);
    renderBriefly();
  });
  resize.observe(container);

  window.addEventListener('pagehide', () => {
    window.clearTimeout(settleTimer);
    resize.disconnect();
    globe.pauseAnimation();
  }, { once: true });
} catch {
  container.hidden = true;
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
