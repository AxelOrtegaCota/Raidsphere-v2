import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@raidsphere/shared';
import { registerWebSocketBoundary } from './websocket.js';
import type { ViewingDependencies } from './websocket.js';
import { registerAuthRoutes } from './routes/auth.js';
import type { AuthRouteDependencies } from './routes/auth.js';

export interface AppDependencies {
  viewing: ViewingDependencies;
  overlayRoot?: string;
  issueViewingCredential: (channelId: string) => string;
  auth?: Omit<AuthRouteDependencies, 'issueViewingCredential'>;
}

export function createApp(dependencies: AppDependencies) {
  // Request logging stays disabled until redaction and retention are designed.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10_000 });

  if (dependencies.overlayRoot) {
    void app.register(fastifyStatic, {
      root: dependencies.overlayRoot,
      prefix: '/__overlay__/',
      decorateReply: true,
    });
    void app.register(fastifyStatic, {
      root: join(dependencies.overlayRoot, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
    });
    void app.register(fastifyStatic, {
      root: join(dependencies.overlayRoot, 'textures'),
      prefix: '/textures/',
      decorateReply: false,
    });
    app.get<{ Params: { channelId: string } }>('/:channelId/overlay', async (request, reply) => {
      if (!/^[A-Za-z0-9_]{1,25}$/.test(request.params.channelId)) {
        return reply.code(404).send({ error: 'Not found.' });
      }
      reply.header('Cache-Control', 'no-store');
      return reply.type('text/html; charset=utf-8').sendFile('index.html', dependencies.overlayRoot);
    });
  }

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

    // Register auth routes (Phase 3)
    registerAuthRoutes(app, { issueViewingCredential: dependencies.issueViewingCredential, ...dependencies.auth });

    return app;
}

// Handler errors are untyped; only a bounded client status code is trusted.
function clientErrorStatus(error: unknown): number {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode : undefined;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
    ? statusCode : 500;
}
