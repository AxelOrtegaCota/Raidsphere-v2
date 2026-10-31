import { fileURLToPath } from 'node:url';
import { createRuntime, demoOverlayUrls } from './composition.js';
import { loadServerConfig } from './config.js';
import { startupLines } from './startup.js';

async function start(): Promise<void> {
  const config = loadServerConfig({ PORT: process.env.PORT, HOST: process.env.HOST });
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
  for (const line of startupLines(config, demoOverlayUrls(issuedCredentials))) console.info(line);
}

void start().catch(() => {
  console.error('RaidSphere could not start. Check the local configuration and port availability.');
  process.exitCode = 1;
});
