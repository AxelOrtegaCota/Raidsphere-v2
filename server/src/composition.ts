import { createApp } from './app.js';
import type { AppDependencies } from './app.js';
import { ChatTranslationPipeline } from './application/chat-translation.js';
import type { ChatTranslationLimits } from './application/chat-translation.js';
import type { CandidateSource, RaidGateway } from './application/ports.js';
import { eligibleChannels } from './application/eligibility.js';
import { EventPublisher } from './application/publisher.js';
import { RouletteCoordinator } from './application/roulette.js';
import type { RouletteConfig } from './application/roulette.js';
import { cryptoRandom, systemClock, timerScheduler } from './application/runtime.js';
import { InMemoryRouletteRepository, InMemoryStreamerRepository } from './persistence/memory.js';
import {
  DEMO_SOURCE_ID, syntheticCandidateSource, syntheticLiveChannels, syntheticStreamers,
} from './simulation/fixtures.js';
import { ServiceChatTranslator } from './translation/chat-translator.js';
import { MockTranslationProvider } from './translation/mock-provider.js';
import { RaidGatewayAdapter } from './twitch/adapters.js';
import { LiveChat } from './twitch/live-chat.js';
import type { LiveChatOptions } from './twitch/live-chat.js';
import { RealRaidGateway } from './twitch/real-raid-gateway.js';
import type { RealRaidOptions } from './twitch/real-raid-gateway.js';
import { RegisteredCandidateSource } from './twitch/registered-candidates.js';
import type { RegisteredCandidateOptions } from './twitch/registered-candidates.js';
import { SimulatedRaidGateway } from './twitch/raids.js';
import type { SimulationConfig } from './twitch/raids.js';
import { ViewingCredentials } from './viewing/credentials.js';
import { OVERLAY_ORIGIN } from './websocket.js';
import type { ViewingLimits } from './websocket.js';

// Composes the Phase 2 simulation runtime: real clock and timers, in-memory state with
// synthetic fixtures, simulated raids, and read-only viewing (D2-11, D2-12, D2-15).
// Raids use the Module B simulated gateway through its adapter to the raid port, and chat
// translation uses the Module C service with its simulated provider (Phase 4, module 4).
// Real Twitch chat is opt-in: without liveChat, no EventSub connection ever opens.
// Real candidates need it too, and they replace synthetic channels instead of joining them.
// Real raids need both, so a raid can never target a synthetic channel.

export interface RuntimeOptions {
  // Receives fixed, content-free messages only.
  reportError: (message: string) => void;
  roulette?: Partial<RouletteConfig>;
  simulatedRaid?: Partial<SimulationConfig>;
  chatTranslationLimits?: Partial<ChatTranslationLimits>;
  viewingLimits?: Partial<ViewingLimits>;
  overlayRoot?: string;
  liveChat?: LiveChatOptions;
  realCandidates?: RegisteredCandidateOptions;
  realRaids?: RealRaidOptions;
}

export function createRuntime(options: RuntimeOptions) {
  const publisher = new EventPublisher({
    clock: systemClock, onError: () => options.reportError('An event could not be published or delivered.'),
  });
  let coordinator: RouletteCoordinator | null = null;
  const streamers = new InMemoryStreamerRepository(syntheticStreamers);
  const raidGateway = new SimulatedRaidGateway(options.simulatedRaid);
  const simulatedRaids = new RaidGatewayAdapter({
    gateway: raidGateway, streamers, onArrival: (arrival) => coordinator?.handleArrival(arrival),
  });
  const useRealRaids = Boolean(options.realRaids && options.liveChat && options.realCandidates);
  if (options.realRaids && !useRealRaids) options.reportError('Real raids stay off: they need real chat and real candidates.');
  const raids: RaidGateway = useRealRaids
    ? new RealRaidGateway({
      ...options.realRaids, reportError: options.reportError,
      tokenProvider: (channelId) => liveChat?.tokenProvider(channelId) ?? null,
    })
    : simulatedRaids;
  let chatMessages: ChatTranslationPipeline | null = null;
  const candidates: CandidateSource = options.liveChat && options.realCandidates
    ? new RegisteredCandidateSource({
      ...options.realCandidates, streamers, reportError: options.reportError,
      connectedChannels: (): readonly string[] => liveChat?.readyChannels() ?? [],
    })
    : syntheticCandidateSource;
  const rouletteCoordinator = new RouletteCoordinator({
    clock: systemClock, scheduler: timerScheduler, random: cryptoRandom,
    streamers, sessions: new InMemoryRouletteRepository(),
    candidates, raids, publisher,
    onError: () => options.reportError('A roulette task failed.'),
    onTranslationWindow: (window) => chatMessages?.handleWindow(window),
    ...(options.roulette ? { config: options.roulette } : {}),
  });
  coordinator = rouletteCoordinator;
  const translator = new ServiceChatTranslator({ provider: new MockTranslationProvider(), simulationMode: true });
  const chatPipeline = new ChatTranslationPipeline({
    clock: systemClock, windows: rouletteCoordinator, translator, publisher,
    onError: () => options.reportError('A chat message could not be translated.'),
    ...(options.chatTranslationLimits ? { limits: options.chatTranslationLimits } : {}),
  });
  chatMessages = chatPipeline;
  const liveChat: LiveChat | null = options.liveChat
    ? new LiveChat({
      ...options.liveChat, streamers, commands: rouletteCoordinator, chat: chatPipeline, reportError: options.reportError,
    })
    : null;
  const { credentials, issued } = ViewingCredentials.issue(syntheticStreamers.map((streamer) => streamer.id));
  const app = createApp({
    viewing: {
      views: rouletteCoordinator, credentials,
      ...(options.viewingLimits ? { limits: options.viewingLimits } : {}),
    },
    ...(options.overlayRoot ? { overlayRoot: options.overlayRoot } : {}),
    issueViewingCredential: (channelId) => credentials.issueForChannel(channelId),
    mode: useRealRaids ? 'live' : 'simulation',
    ...(liveChat ? {
      auth: {
        onAuthenticated: (session) => liveChat.connect(session),
        onLogout: async (session) => { liveChat.disconnect(session.user.id); },
        eventSubState: (channelId) => liveChat.state(channelId),
        realRaids: useRealRaids,
      },
    } satisfies Pick<AppDependencies, 'auth'> : {}),
  });
  app.addHook('onClose', async () => {
    liveChat?.close();
    rouletteCoordinator.close();
    chatPipeline.close();
    translator.close();
    simulatedRaids.close();
    raidGateway.dispose();
  });
  return { app, coordinator: rouletteCoordinator, chatMessages: chatPipeline, liveChat, issuedCredentials: issued };
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
