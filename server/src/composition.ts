import { createApp } from './app.js';
import { eligibleChannels } from './application/eligibility.js';
import { EventPublisher } from './application/publisher.js';
import { RouletteCoordinator } from './application/roulette.js';
import type { RouletteConfig } from './application/roulette.js';
import { cryptoRandom, systemClock, timerScheduler } from './application/runtime.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from './persistence/memory.js';
import {
  DEMO_SOURCE_ID, syntheticCandidateSource, syntheticLiveChannels, syntheticStreamers,
} from './simulation/fixtures.js';
import { RaidGatewayAdapter } from './twitch/adapters.js';
import { SimulatedRaidGateway } from './twitch/raids.js';
import type { SimulationConfig } from './twitch/raids.js';
import { ViewingCredentials } from './viewing/credentials.js';
import { OVERLAY_ORIGIN } from './websocket.js';
import type { ViewingLimits } from './websocket.js';

// Composes the Phase 2 simulation runtime: real clock and timers, in-memory state with
// synthetic fixtures, simulated raids, and read-only viewing (D2-11, D2-12, D2-15).
// Raids use the Module B simulated gateway through its adapter to the raid port.

export interface RuntimeOptions {
  // Receives fixed, content-free messages only.
  reportError: (message: string) => void;
  roulette?: Partial<RouletteConfig>;
  simulatedRaid?: Partial<SimulationConfig>;
  viewingLimits?: Partial<ViewingLimits>;
}

export function createRuntime(options: RuntimeOptions) {
  const publisher = new EventPublisher({
    clock: systemClock, onError: () => options.reportError('An event could not be published or delivered.'),
  });
  let coordinator: RouletteCoordinator | null = null;
  const streamers = new InMemoryStreamerRepository(syntheticStreamers);
  const raidGateway = new SimulatedRaidGateway(options.simulatedRaid);
  const raids = new RaidGatewayAdapter({
    gateway: raidGateway, streamers, onArrival: (arrival) => coordinator?.handleArrival(arrival),
  });
  const rouletteCoordinator = new RouletteCoordinator({
    clock: systemClock, scheduler: timerScheduler, random: cryptoRandom,
    streamers, sessions: new InMemoryRouletteRepository(),
    candidates: syntheticCandidateSource, raids, publisher,
    onError: () => options.reportError('A roulette task failed.'),
    ...(options.roulette ? { config: options.roulette } : {}),
  });
  coordinator = rouletteCoordinator;
  const { credentials, issued } = ViewingCredentials.issue(syntheticStreamers.map((streamer) => streamer.id));
  const app = createApp({
    viewing: {
      views: rouletteCoordinator, credentials,
      ...(options.viewingLimits ? { limits: options.viewingLimits } : {}),
    },
  });
  app.addHook('onClose', async () => {
    rouletteCoordinator.close();
    raids.close();
    raidGateway.dispose();
  });
  return { app, coordinator: rouletteCoordinator, issuedCredentials: issued };
}

// Only the demo source and its possible destinations get a printed OBS URL (D2-16).
export function demoOverlayUrls(issued: ReadonlyMap<string, string>): { channelId: string; url: string }[] {
  const source = syntheticStreamers.find((streamer) => streamer.id === DEMO_SOURCE_ID);
  if (!source) throw new Error('The demo source fixture is missing.');
  const channelIds = [DEMO_SOURCE_ID, ...eligibleChannels(source, syntheticLiveChannels).map((channel) => channel.streamer.id)];
  return channelIds.flatMap((channelId) => {
    const credential = issued.get(channelId);
    // The credential travels in the URL fragment, which browsers never send to servers (D2-11 rule 7).
    return credential ? [{ channelId, url: `${OVERLAY_ORIGIN}/${channelId}/overlay#cred=${credential}` }] : [];
  });
}
