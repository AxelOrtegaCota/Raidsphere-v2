import { createApp } from './app.js';
import { loadServerConfig } from './config.js';

async function start(): Promise<void> {
  const config = loadServerConfig(process.env.PORT === undefined ? {} : { PORT: process.env.PORT });
  const app = createApp();
  const shutdown = async (): Promise<void> => {
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });

  try {
    await app.listen(config);
    console.info(`RaidSphere foundation is listening on loopback port ${config.port}.`);
  } catch {
    await app.close();
    throw new Error('Server startup failed.');
  }
}

void start().catch(() => {
  console.error('RaidSphere could not start. Check the local configuration and port availability.');
  process.exitCode = 1;
});
