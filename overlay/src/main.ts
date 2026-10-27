import Globe from 'globe.gl';
import { PROTOCOL_VERSION } from '@raidsphere/shared';
import './styles.css';

const container = document.querySelector<HTMLElement>('#globe');
const status = document.querySelector<HTMLElement>('#connection-status');

if (!container || !status) {
  throw new Error('The overlay foundation is missing its required elements.');
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

  status.textContent = `Protocol v${PROTOCOL_VERSION}. Channel authorization is pending; no live connection is active.`;
} catch {
  status.textContent = 'The globe preview is unavailable. WebGL support and dependency compatibility have not been verified.';
}

// No viewing credentials, channel data, Twitch requests, or AI calls in Phase 1.
