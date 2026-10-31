import type { ServerConfig } from './config.js';

// Startup log lines for the server entry point. Overlay URLs carry a read-only viewing
// credential, so they are printed only on a loopback binding (D2-11 rule 7, D2-16). A hosted
// deployment (HOST=0.0.0.0) keeps its logs, so it prints no credential; broadcasters get their
// overlay URL from the authenticated dashboard instead.
export function startupLines(config: ServerConfig, overlayUrls: readonly { channelId: string; url: string }[]): string[] {
  if (config.host !== '127.0.0.1') {
    return [
      `RaidSphere is listening on port ${config.port} on all interfaces in simulation mode.`,
      'Overlay URLs are not printed on a public binding; use the dashboard after signing in.',
    ];
  }
  return [
    `RaidSphere is listening on loopback port ${config.port} in simulation mode.`,
    'OBS overlay URLs (do not share or screen-share; valid until the server restarts):',
    ...overlayUrls.map(({ channelId, url }) => `  ${channelId}: ${url}`),
  ];
}
