import { createInterface } from 'node:readline';
import type { LanguageCode, ServerEvent } from '@raidsphere/shared';
import { createRuntime, demoOverlayUrls } from '../composition.js';
import { loadServerConfig } from '../config.js';
import { CommandSimulator } from './commands.js';
import { DEMO_SOURCE_ID } from './fixtures.js';

// Local Phase 2 demo (plan step 9). Everything runs in this process: the keyboard of this
// terminal drives the simulated chat, and no network endpoint accepts commands (D2-05 rule 5).
// Usage: `npm run demo` (interactive) or `npm run demo:auto` (one automatic round).

// [seconds after !roulette, synthetic viewer, vote]. The last two are ignored by design (D2-04).
const VOTE_SCRIPT: readonly (readonly [number, string, LanguageCode])[] = [
  [2, 'viewer_01', 'ja'], [4, 'viewer_02', 'pt'], [6, 'viewer_03', 'ja'], [8, 'viewer_04', 'ko'],
  [10, 'viewer_01', 'en'], [12, 'viewer_05', 'de'],
];
const AUTO_START_DELAY_MS = 3_000;

async function main(): Promise<void> {
  const auto = process.argv.includes('--auto');
  const config = loadServerConfig(process.env.PORT === undefined ? {} : { PORT: process.env.PORT });
  const { app, coordinator, issuedCredentials } = createRuntime({
    reportError: (message) => console.error(message),
    simulatedRaid: { countdownSeconds: 10 },
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
    if (auto && isTerminal(event)) setTimeout(() => { void stop(); }, 500);
  };
  for (const { channelId } of urls) {
    const view = await coordinator.openView(channelId, log);
    if (view) views.push(view);
  }

  const chat = new CommandSimulator(coordinator, DEMO_SOURCE_ID);
  const startRound = async (): Promise<void> => {
    const before = (await coordinator.snapshot(DEMO_SOURCE_ID)).roulette?.sessionId;
    await chat.roulette();
    const after = (await coordinator.snapshot(DEMO_SOURCE_ID)).roulette;
    // Only a newly started session gets the vote script.
    if (after?.status !== 'voting' || after.sessionId === before) return;
    for (const [seconds, userId, language] of VOTE_SCRIPT) {
      const timer = setTimeout(() => {
        voteTimers.delete(timer);
        void chat.vote(userId, language);
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
      void chat.cancel();
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
