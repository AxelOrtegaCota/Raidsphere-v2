// The overlay route serves two audiences. OBS (the default) gets a transparent, non-interactive
// scene that pauses rendering when idle; `?mode=interactive` keeps the discovery tools for a
// browser tab. Neither mode grants any control: both use the same read-only connection.

export type OverlayMode = 'obs' | 'interactive';

export function readOverlayMode(search: string): OverlayMode {
  return new URLSearchParams(search).get('mode') === 'interactive' ? 'interactive' : 'obs';
}

// The Simulation label stays unless the server positively reports live mode.
export function showsSimulationLabel(health: unknown): boolean {
  return !(typeof health === 'object' && health !== null && 'mode' in health && health.mode === 'live');
}
