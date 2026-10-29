import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@raidsphere/shared';
import { registerWebSocketBoundary } from './websocket.js';
import type { ViewingDependencies } from './websocket.js';

export interface AppDependencies {
  viewing: ViewingDependencies;
}

export function createApp(dependencies: AppDependencies) {
  // Request logging stays disabled until redaction and retention are designed.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10_000 });

  app.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      application: 'RaidSphere',
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      // Phase 2 runs only with synthetic channels and simulated raids (D2-15).
      mode: 'simulation',
      // Read-only channel subscriptions exist; no remote control path does (D2-11).
      capabilities: { channelSubscriptions: true, controlCommands: false },
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    // Avoid reflecting exception objects, validation input, or private paths.
    reply.code(clientErrorStatus(error)).send({ error: 'The request could not be processed.' });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found.' });
  });

  registerWebSocketBoundary(app, dependencies.viewing);
  return app;
}

// Handler errors are untyped; only a bounded client status code is trusted.
function clientErrorStatus(error: unknown): number {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode : undefined;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
    ? statusCode : 500;
}
