import { fileURLToPath } from 'node:url';
import { createRuntime, demoOverlayUrls } from './composition.js';
import { loadServerConfig } from './config.js';

async function start(): Promise<void> {
  const config = loadServerConfig(process.env.PORT === undefined && process.env.HOST === undefined ? {} : { PORT: process.env.PORT, HOST: process.env.HOST });
  const overlayRoot = fileURLToPath(new URL('../../overlay/dist/', import.meta.url));
  const { app, issuedCredentials } = createRuntime({
    reportError: (message) => console.error(message),
    overlayRoot,
  });
  const shutdown = async (): Promise<void> => {
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });

  try {
    await app.listen(config);
  } catch {
    await app.close();
    throw new Error('Server startup failed.');
  }
  console.info(`RaidSphere is listening on loopback port ${config.port} in simulation mode.`);
  // Printed once, locally only (D2-11 rule 7, D2-16). Each URL contains a read-only viewing credential.
  console.info('OBS overlay URLs (do not share or screen-share; valid until the server restarts):');
  for (const { channelId, url } of demoOverlayUrls(issuedCredentials)) console.info(`  ${channelId}: ${url}`);
}

void start().catch(() => {
  console.error('RaidSphere could not start. Check the local configuration and port availability.');
  process.exitCode = 1;
});
