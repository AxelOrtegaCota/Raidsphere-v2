// The overlay route serves two audiences. OBS gets a transparent, non-interactive scene that
// pauses rendering when idle. A browser tab gets the discovery tools: `?mode=interactive`, or
// any page opened without a viewing credential, since OBS URLs always carry one. Neither mode
// grants any control.

export type OverlayMode = 'obs' | 'interactive';

export function readOverlayMode(search: string, hasCredential: boolean): OverlayMode {
  return !hasCredential || new URLSearchParams(search).get('mode') === 'interactive' ? 'interactive' : 'obs';
}

// The Simulation label stays unless the server positively reports live mode.
export function showsSimulationLabel(health: unknown): boolean {
  return !(typeof health === 'object' && health !== null && 'mode' in health && health.mode === 'live');
}
