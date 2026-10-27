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

  globe.pointOfView({ lat: 18, lng: -30, altitude: 2.4 });
  globe.controls().enabled = false;

  // Render the initial view, then suspend continuous work in this static preview.
  const frame = requestAnimationFrame(() => globe.pauseAnimation());
  const resize = new ResizeObserver(() => {
    globe.width(container.clientWidth).height(container.clientHeight);
    globe.resumeAnimation();
    requestAnimationFrame(() => globe.pauseAnimation());
  });
  resize.observe(container);

  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    globe.pauseAnimation();
  }, { once: true });

  status.textContent = `Protocol v${PROTOCOL_VERSION}. Channel authorization is pending; no live connection is active.`;
} catch {
  status.textContent = 'The globe preview is unavailable. WebGL support and dependency compatibility have not been verified.';
}

// No viewing credentials, channel data, Twitch requests, or AI calls in Phase 1.
