import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@raidsphere/shared';
import { registerWebSocketBoundary } from './websocket.js';

export function createApp() {
  // Request logging stays disabled until redaction and retention are designed.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10_000 });

  app.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      application: 'RaidSphere',
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { channelSubscriptions: false, controlCommands: false },
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    // Avoid reflecting exception objects, validation input, or private paths.
    reply.code(clientErrorStatus(error)).send({ error: 'The request could not be processed.' });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found.' });
  });

  registerWebSocketBoundary(app);
  return app;
}

// Handler errors are untyped; only a bounded client status code is trusted.
function clientErrorStatus(error: unknown): number {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode : undefined;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
    ? statusCode : 500;
}
