import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  candidateSchema, cancelControlSchema, controlResultSchema, controlStatusSchema, languageCodeSchema,
  preparedRouletteSchema, prepareRouletteSchema, raidControlSchema, spinControlSchema, streamerSchema,
} from '@raidsphere/shared';
import type { Candidate, Streamer } from '@raidsphere/shared';
import type { RandomSource } from '../application/ports.js';
import { ControlConflict, type RouletteCoordinator } from '../application/roulette.js';
import { autoCandidates, manualCandidates } from '../application/selection.js';
import type { StreamerRepository } from '../persistence/contracts.js';
import { getStreams, getStreamsPage, type HelixRequestConfig, type Stream } from '../twitch/helix.js';
import { loadOAuthConfig } from '../twitch/oauth.js';
import type { UserSession } from '../twitch/sessions.js';
import { currentSession } from './auth.js';
import { createRateLimiter } from './rate-limit.js';

export interface ControlDependencies {
  coordinator: RouletteCoordinator;
  streamers: StreamerRepository;
  random: RandomSource;
  simulated: boolean;
  canRaid?: (channelId: string) => boolean;
  readStreams?: (session: UserSession, ids: readonly string[]) => Promise<readonly Stream[]>;
  discoverStreams?: (session: UserSession) => Promise<{ streams: readonly Stream[]; limited: boolean }>;
}

const configFor = (session: UserSession): HelixRequestConfig => ({
  clientId: loadOAuthConfig(process.env).clientId, accessToken: session.tokens.access_token,
});

// Revalidate normalized provider data too, including injected adapters.
export function streamCandidate(stream: Stream): Candidate {
  if (stream.type !== 'live' || !/^[0-9]{1,25}$/.test(stream.userId)) throw new Error('Invalid live stream.');
  return candidateSchema.parse({
    streamerId: stream.userId, login: stream.userLogin, displayName: stream.userName, avatarUrl: null,
    language: stream.language || 'und', illustrativeCountry: null, viewers: stream.viewerCount,
    gameName: stream.gameName, title: stream.title,
  });
}

type Prepared = z.infer<typeof preparedRouletteSchema>;

export function registerControlRoutes(app: FastifyInstance, dependencies: ControlDependencies): void {
  const { coordinator, streamers, random, simulated } = dependencies;
  const pools = new Map<string, Prepared>();
  const limit = createRateLimiter({ windowMs: 60_000, max: 30, maxKeys: 1_000 });
  // No delayed quota retries before a control action could submit a raid.
  const readStreams = dependencies.readStreams ?? ((session, ids) => getStreams(configFor(session), ids, 100, 1));
  const discover = dependencies.discoverStreams ?? (async (session: UserSession) => {
    const streams: Stream[] = [];
    let cursor: string | undefined;
    // Four pages is a fixed upper bound, not an assertion of global Twitch availability.
    for (let page = 0; page < 4; page += 1) {
      const result = await getStreamsPage(configFor(session), cursor);
      streams.push(...result.streams);
      cursor = result.cursor;
      if (!cursor) break;
    }
    return { streams, limited: Boolean(cursor) };
  });

  function authenticate(request: FastifyRequest, reply: FastifyReply, write = false): UserSession | null {
    reply.header('Cache-Control', 'no-store');
    const session = currentSession(request);
    if (!session) { void reply.code(401).send({ error: 'Log in with Twitch to control your channel.' }); return null; }
    if (session.userId !== session.user.id || session.overlay.channelId !== session.user.id || !/^[0-9]{1,25}$/.test(session.user.id)) {
      void reply.code(403).send({ error: 'The session does not own this channel.' }); return null;
    }
    if (write) {
      const origin = request.headers.origin;
      let validOrigin = true;
      if (origin) {
        try {
          const url = new URL(origin);
          validOrigin = ['http:', 'https:'].includes(url.protocol) && url.host === request.headers.host;
        } catch { validOrigin = false; }
      }
      if (!validOrigin || request.headers['sec-fetch-site'] === 'cross-site' || request.headers['x-raidsphere-control'] !== '1') {
        void reply.code(403).send({ error: 'Use the RaidSphere control room on this origin.' }); return null;
      }
      const decision = limit(session.user.id);
      if (!decision.allowed) {
        void reply.code(429).header('Retry-After', String(decision.retryAfterSeconds)).send({ error: 'Too many control requests.' }); return null;
      }
    }
    return session;
  }

  function body<T>(schema: z.ZodType<T>, request: FastifyRequest, reply: FastifyReply, session: UserSession): T | null {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) { void reply.code(400).send({ error: 'Invalid control input.' }); return null; }
    if ((parsed.data as { channelId: string }).channelId !== session.user.id) {
      void reply.code(403).send({ error: 'You can control only your own channel.' }); return null;
    }
    return parsed.data;
  }

  async function liveSource(session: UserSession): Promise<{ source: Streamer; candidate: Candidate }> {
    const streams = await readStreams(session, [session.user.id]);
    const stream = streams.find((entry) => entry.userId === session.user.id);
    if (!stream) throw new ControlConflict('Your source stream is offline. A raid requires a live source stream.');
    const candidate = streamCandidate(stream);
    const stored = await streamers.findById(session.user.id);
    const language = languageCodeSchema.safeParse(candidate.language);
    const source = streamerSchema.parse({
      id: session.user.id, login: session.user.login, displayName: session.user.display_name,
      avatarUrl: session.user.profile_image_url.startsWith('https://') ? session.user.profile_image_url : null,
      language: language.success ? language.data : stored?.language ?? 'en',
      minViewers: stored?.minViewers ?? 0, maxViewers: stored?.maxViewers ?? 1_000_000,
      acceptsOtherLanguages: stored?.acceptsOtherLanguages ?? true, reputation: stored?.reputation ?? 0,
    });
    // Register only the authenticated owner. Destinations never gain translation access here.
    if (!stored) await streamers.save(source);
    return { source, candidate };
  }

  async function destinations(session: UserSession, ids: readonly string[]): Promise<Candidate[]> {
    return (await readStreams(session, ids)).filter((stream) => ids.includes(stream.userId)).map(streamCandidate);
  }

  const result = (roulette: Awaited<ReturnType<RouletteCoordinator['browserSpin']>>) => controlResultSchema.parse({ roulette, simulated });
  const failure = (reply: FastifyReply, error: unknown) => reply.code(error instanceof ControlConflict ? 409 : 502).send({
    error: error instanceof ControlConflict ? error.message : 'Live channel information could not be verified. No automatic retry was made.',
  });

  app.get('/api/control/status', async (request, reply) => {
    const session = authenticate(request, reply);
    if (!session) return reply;
    try {
      const live = (await readStreams(session, [session.user.id])).find((entry) => entry.userId === session.user.id);
      const candidate = live ? streamCandidate(live) : null;
      return controlStatusSchema.parse({
        channelId: session.user.id, login: session.user.login, isLive: candidate !== null, viewers: candidate?.viewers ?? 0,
        simulated, roulette: (await coordinator.snapshot(session.user.id)).roulette,
      });
    } catch (error) { return failure(reply, error); }
  });

  app.post('/api/control/prepare', async (request, reply) => {
    const session = authenticate(request, reply, true);
    if (!session) return reply;
    const input = body(prepareRouletteSchema, request, reply, session);
    if (!input) return reply;
    try {
      const { source: preferences, candidate: source } = await liveSource(session);
      const eligible = (candidate: Candidate): boolean => candidate.viewers >= preferences.minViewers &&
        candidate.viewers <= preferences.maxViewers && (preferences.acceptsOtherLanguages || candidate.language === preferences.language);
      let candidates: Candidate[];
      let discoveryLimited = false;
      if (input.mode === 'manual') {
        const live = await destinations(session, input.candidateIds);
        try { candidates = manualCandidates(source.streamerId, input.candidateIds, live.filter(eligible)); }
        catch { throw new ControlConflict('Select unique destinations that are still live and match your preferences, excluding your own channel.'); }
      } else {
        const discovery = await discover(session);
        candidates = autoCandidates(source.streamerId, source.viewers, discovery.streams.map(streamCandidate).filter(eligible), input.count, random);
        discoveryLimited = discovery.limited;
      }
      // One short-lived pool per owner, with bounded process memory.
      for (const [owner, pool] of pools) if (pool.expiresAtMs <= Date.now()) pools.delete(owner);
      if (!pools.has(source.streamerId) && pools.size >= 1_000) throw new ControlConflict('Candidate preparation is at capacity.');
      const prepared = preparedRouletteSchema.parse({
        poolId: randomUUID(), mode: input.mode, candidates, sourceViewers: source.viewers,
        minViewers: source.viewers * 0.5, maxViewers: source.viewers * 2,
        discoveryLimited, expiresAtMs: Date.now() + 120_000,
      });
      pools.set(session.user.id, prepared);
      return prepared;
    } catch (error) { return failure(reply, error); }
  });

  app.post('/api/control/spin', async (request, reply) => {
    const session = authenticate(request, reply, true);
    if (!session) return reply;
    const input = body(spinControlSchema, request, reply, session);
    if (!input) return reply;
    try {
      const pool = pools.get(session.user.id);
      if (!pool || pool.poolId !== input.poolId || pool.expiresAtMs <= Date.now() || !pool.candidates.length) throw new ControlConflict('Prepare live candidates again before spinning.');
      const { source, candidate } = await liveSource(session);
      const ids = pool.candidates.map((entry) => entry.streamerId);
      const live = await destinations(session, ids);
      let refreshed: Candidate[];
      try { refreshed = manualCandidates(source.id, ids, live); }
      catch { throw new ControlConflict('A destination is no longer live. Prepare candidates again.'); }
      if (refreshed.some((entry) => entry.viewers < source.minViewers || entry.viewers > source.maxViewers ||
          (!source.acceptsOtherLanguages && entry.language !== source.language))) {
        throw new ControlConflict('A destination no longer matches your configured preferences. Prepare candidates again.');
      }
      if (pool.mode === 'auto' && refreshed.some((entry) => entry.viewers < candidate.viewers * 0.5 || entry.viewers > candidate.viewers * 2)) {
        throw new ControlConflict('Viewer counts changed outside the required range. Prepare candidates again.');
      }
      return result(await coordinator.browserSpin(source, refreshed, pool.mode, input.requestId, candidate.language));
    } catch (error) { return failure(reply, error); }
  });

  app.post('/api/control/raid', async (request, reply) => {
    const session = authenticate(request, reply, true);
    if (!session) return reply;
    const input = body(raidControlSchema, request, reply, session);
    if (!input) return reply;
    try {
      if (!simulated && dependencies.canRaid?.(session.user.id) !== true) throw new ControlConflict('Wait for the source EventSub connection before starting a real raid.');
      const { source, candidate: sourceStream } = await liveSource(session);
      if (input.sessionId !== undefined) {
        const current = (await coordinator.snapshot(source.id)).roulette;
        if (!current || current.sessionId !== input.sessionId || !current.chosenCandidate) throw new ControlConflict('The selected session is no longer current.');
        if (current.status === 'chosen' && !(await destinations(session, [current.chosenCandidate.streamerId])).length) throw new ControlConflict('The selected destination is no longer live.');
        return result(await coordinator.browserRaid(source, input.requestId, { sessionId: input.sessionId }, sourceStream.language));
      }
      const target = (await destinations(session, [input.toStreamerId!]))[0];
      if (!target || target.streamerId === source.id) throw new ControlConflict('Choose another live destination.');
      return result(await coordinator.browserRaid(source, input.requestId, target, sourceStream.language));
    } catch (error) { return failure(reply, error); }
  });

  app.post('/api/control/cancel', async (request, reply) => {
    const session = authenticate(request, reply, true);
    if (!session) return reply;
    const input = body(cancelControlSchema, request, reply, session);
    if (!input) return reply;
    try { return result(await coordinator.browserCancel(session.user.id, input.sessionId, input.requestId)); }
    catch (error) { return failure(reply, error); }
  });
}
