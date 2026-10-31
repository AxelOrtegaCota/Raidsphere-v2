import { createInterface } from 'node:readline';
import type { LanguageCode, ServerEvent } from '@raidsphere/shared';
import { createRuntime, demoOverlayUrls } from '../composition.js';
import { loadServerConfig } from '../config.js';
import { SimulatedChat } from '../twitch/simulated-chat.js';
import { DEMO_SOURCE_ID } from './fixtures.js';

// Local Phase 2 demo (plan step 9). Everything runs in this process: the keyboard of this
// terminal drives the simulated chat, and no network endpoint accepts commands (D2-05 rule 5).
// Chat text goes through the Module B parser; raids use the Module B simulated gateway.
// Usage: `npm run demo` (interactive) or `npm run demo:auto` (one automatic round).

// [seconds after !roulette, synthetic viewer, vote]. The last two are ignored by design (D2-04).
const VOTE_SCRIPT: readonly (readonly [number, string, LanguageCode])[] = [
  [2, 'viewer_01', 'ja'], [4, 'viewer_02', 'pt'], [6, 'viewer_03', 'ja'], [8, 'viewer_04', 'ko'],
  [10, 'viewer_01', 'en'], [12, 'viewer_05', 'de'],
];
// [seconds after the arrival, synthetic raider, language, text]. The last one is skipped by
// design: a command is never translated.
const RAIDER_SCRIPT: readonly (readonly [number, string, LanguageCode, string])[] = [
  [2, 'raider_01', 'en', 'thanks for the raid'], [4, 'raider_02', 'es', 'hola a todos'],
  [6, 'raider_03', 'pt', 'boa live'], [8, 'raider_04', 'fr', 'bonjour le chat'],
  [10, 'raider_01', 'en', '!vote ja'],
];
const AUTO_STOP_AFTER_ARRIVAL_MS = 14_000;
const AUTO_START_DELAY_MS = 3_000;
// The demo raid is always accepted and arrives after a fixed, visible countdown.
const DEMO_RAID = {
  acceptRate: 1, arrivalRate: 1, minCountdownMs: 10_000, maxCountdownMs: 10_000, observationTimeoutMs: 20_000,
} as const;

async function main(): Promise<void> {
  const auto = process.argv.includes('--auto');
  const config = loadServerConfig(process.env.PORT === undefined ? {} : { PORT: process.env.PORT });
  const { app, coordinator, chatMessages, issuedCredentials } = createRuntime({
    reportError: (message) => console.error(message),
    simulatedRaid: DEMO_RAID,
  });
  await app.listen(config);
  const startedAtMs = Date.now();
  const urls = demoOverlayUrls(issuedCredentials);

  console.info(`RaidSphere demo is listening on loopback port ${config.port} in simulation mode (synthetic channels, no real raids).`);
  // Printed once, locally only (D2-11 rule 7, D2-16). Each URL contains a read-only viewing credential.
  console.info('OBS overlay URLs (do not share or screen-share; valid until the demo stops):');
  for (const { channelId, url } of urls) console.info(`  ${channelId}: ${url}`);

  const voteTimers = new Set<NodeJS.Timeout>();
  const clearVotes = (): void => {
    for (const timer of voteTimers) clearTimeout(timer);
    voteTimers.clear();
  };
  let stopping = false;
  const views: { close: () => void }[] = [];
  let input: ReturnType<typeof createInterface> | null = null;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearVotes();
    for (const view of views) view.close();
    input?.close();
    await app.close();
    console.info('Demo stopped.');
  };

  const log = (event: ServerEvent): void => {
    const elapsed = ((Date.now() - startedAtMs) / 1_000).toFixed(1);
    console.info(`[+${elapsed}s] ${event.channelId.padEnd(13)} ${event.type.padEnd(15)} ${describe(event)}`);
    if (event.type === 'raid:arrived') startRaiderChat(event.channelId);
    if (auto && isTerminal(event)) {
      setTimeout(() => { void stop(); }, event.type === 'raid:arrived' ? AUTO_STOP_AFTER_ARRIVAL_MS : 500);
    }
  };
  const startRaiderChat = (channelId: string): void => {
    const raiders = new SimulatedChat(coordinator, channelId, chatMessages);
    for (const [seconds, userId, language, text] of RAIDER_SCRIPT) {
      const timer = setTimeout(() => {
        voteTimers.delete(timer);
        void raiders.say({ userId, language }, text);
      }, seconds * 1_000);
      voteTimers.add(timer);
    }
  };
  for (const { channelId } of urls) {
    const view = await coordinator.openView(channelId, log);
    if (view) views.push(view);
  }

  const chat = new SimulatedChat(coordinator, DEMO_SOURCE_ID);
  const startRound = async (): Promise<void> => {
    const before = (await coordinator.snapshot(DEMO_SOURCE_ID)).roulette?.sessionId;
    await chat.say(chat.broadcaster, '!roulette');
    const after = (await coordinator.snapshot(DEMO_SOURCE_ID)).roulette;
    // Only a newly started session gets the vote script.
    if (after?.status !== 'voting' || after.sessionId === before) return;
    for (const [seconds, userId, language] of VOTE_SCRIPT) {
      const timer = setTimeout(() => {
        voteTimers.delete(timer);
        void chat.say({ userId }, `!vote ${language}`);
      }, seconds * 1_000);
      voteTimers.add(timer);
    }
  };

  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (auto) {
    console.info(`Automatic round: !roulette in ${AUTO_START_DELAY_MS / 1_000} s; the demo stops when the session ends.`);
    setTimeout(() => { void startRound(); }, AUTO_START_DELAY_MS);
    return;
  }
  console.info('Press Enter for !roulette, "c" + Enter for !cancel, "q" + Enter to quit.');
  input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const key = line.trim().toLowerCase();
    if (key === '') void startRound();
    else if (key === 'c') {
      clearVotes();
      void chat.say(chat.broadcaster, '!cancel');
    } else if (key === 'q') void stop();
  });
}

function isTerminal(event: ServerEvent): boolean {
  return event.type === 'raid:arrived' || event.type === 'raid:cancelled' || event.type === 'error';
}

function describe(event: ServerEvent): string {
  switch (event.type) {
    case 'state:snapshot':
      return event.payload.roulette ? `session ${event.payload.roulette.status}` : 'idle';
    case 'roulette:start':
      return `${event.payload.candidates.length} candidates, languages ${event.payload.languages.join(' ')}, voting ends in ` +
        `${Math.round((event.payload.votingEndsAtMs - event.occurredAtMs) / 1_000)} s`;
    case 'roulette:votes':
      return `${Object.entries(event.payload.votes).map(([language, count]) => `${language}=${count}`).join(' ')} (total ${event.payload.totalVotes})`;
    case 'roulette:chosen':
      return `${event.payload.winningLanguage} -> ${event.payload.candidate.streamerId} ` +
        `(${event.payload.fromCountry ?? '?'} -> ${event.payload.toCountry ?? '?'})`;
    case 'raid:started':
      return `to ${event.payload.toLogin}, countdown ${event.payload.estimatedCountdownSeconds ?? '?'} s (simulated)`;
    case 'raid:cancelled':
      return event.payload.reason;
    case 'raid:arrived':
      return `from ${event.payload.fromLogin}, ${event.payload.viewers} viewers (simulated)`;
    case 'translation:window':
      return `${event.payload.status}, target ${event.payload.targetLanguage}`;
    case 'translate:bubble':
      return `${event.payload.status} ${event.payload.fromLanguage ?? '?'} -> ${event.payload.toLanguage} (simulated)`;
    case 'error':
      return event.payload.code;
    default:
      return '';
  }
}

void main().catch(() => {
  console.error('The RaidSphere demo could not start. Check the local configuration and port availability.');
  process.exitCode = 1;
});
