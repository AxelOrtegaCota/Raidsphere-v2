import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, publicRouletteStateSchema, serverEventSchema } from '@raidsphere/shared';
import type { Candidate, LanguageCode, ServerEvent } from '@raidsphere/shared';
import { COUNTRY_POINTS, EMPTY_SCENE, globeScene, interpolateView } from '../src/globe-session.js';
import { readOverlayMode, showsSimulationLabel, simulationLabel } from '../src/overlay-mode.js';
import { presentSessionPanel } from '../src/control-room';
import { describeRoulettePanel } from '../src/roulette-panel.js';
import { applyControlState, applyEvent, describeView, initialViewState } from '../src/view-state.js';
import type { ViewState } from '../src/view-state.js';

// All identifiers are synthetic fixtures.
const SOURCE = 'rsdemo_es_01';
const SESSION = 'session-1';
const START = 1_000_000;
let sequence = 0;

function event(type: ServerEvent['type'], payload: unknown, extra: Record<string, unknown> = {}): ServerEvent {
  sequence += 1;
  return serverEventSchema.parse({
    version: PROTOCOL_VERSION, eventId: randomUUID(), channelId: SOURCE, occurredAtMs: START, sequence,
    type, payload, ...extra,
  });
}

function candidate(id: string, language: LanguageCode, country: Candidate['illustrativeCountry'], viewers = 12): Candidate {
  return {
    streamerId: id, login: id, displayName: `Demo ${id}`, avatarUrl: null, language,
    illustrativeCountry: country, viewers, gameName: 'Synthetic Category', title: `[Synthetic] ${id}`,
  };
}

const POOL = [
  candidate('rsdemo_ja_01', 'ja', 'JP'), candidate('rsdemo_pt_01', 'pt', 'BR'),
  candidate('rsdemo_pt_02', 'pt', 'BR', 1), candidate('rsdemo_ko_02', 'ko', 'KR'),
];

const started = (): ViewState => applyEvent(initialViewState, event('roulette:start', {
  candidates: POOL, languages: ['ja', 'pt', 'ko'], votingEndsAtMs: START + 30_000,
}, { sessionId: SESSION }));
const voted = (state: ViewState, votes: Partial<Record<LanguageCode, number>>) => applyEvent(state, event('roulette:votes', {
  votes, totalVotes: Object.values(votes).reduce((sum, count) => sum + (count ?? 0), 0),
}, { sessionId: SESSION }));
const chosen = (state: ViewState) => applyEvent(state, event('roulette:chosen', {
  candidate: POOL[0], winningLanguage: 'ja', fromCountry: 'MX', toCountry: 'JP',
}, { sessionId: SESSION }));
const raidStarted = (state: ViewState) => applyEvent(state, event('raid:started', {
  toStreamerId: 'rsdemo_ja_01', toLogin: 'rsdemo_ja_01', requestedAtMs: START, estimatedCountdownSeconds: 10,
}, { sessionId: SESSION }));

describe('overlay mode', () => {
  it('hides the interactive headline without a session and keeps it for each session outcome', () => {
    const panel = { hidden: false, dataset: {} as Record<string, string> };
    presentSessionPanel(panel as unknown as HTMLElement, 'interactive', null);
    expect(panel.hidden).toBe(true);
    const state = chosen(started()).roulette!;
    for (const status of ['voting', 'selecting', 'chosen', 'raid_pending', 'done', 'cancelled', 'failed', 'unknown'] as const) {
      const session = publicRouletteStateSchema.parse({
        ...state, status, chosenCandidate: status === 'voting' || status === 'selecting' ? null : state.chosenCandidate,
      });
      presentSessionPanel(panel as unknown as HTMLElement, 'interactive', session);
      expect(panel.hidden).toBe(false);
      expect(panel.dataset.hasSession).toBe('true');
    }
  });
  it('leaves the OBS headline unchanged with or without a session and preserves its winner model', () => {
    const headlinePanel = { hidden: false, dataset: {} as Record<string, string> };
    presentSessionPanel(headlinePanel as unknown as HTMLElement, 'obs', null);
    presentSessionPanel(headlinePanel as unknown as HTMLElement, 'obs', chosen(started()).roulette);
    expect(headlinePanel).toEqual({ hidden: false, dataset: {} });
    expect(describeRoulettePanel(chosen(started()))?.winner?.name).toBe('Demo rsdemo_ja_01');
  });
  it('defaults to OBS with a credential and opts into interactive mode explicitly', () => {
    expect(readOverlayMode('', true)).toBe('obs');
    expect(readOverlayMode('?mode=obs', true)).toBe('obs');
    expect(readOverlayMode('?mode=anything', true)).toBe('obs');
    expect(readOverlayMode('?mode=interactive', true)).toBe('interactive');
  });

  it('treats a page without a credential as a browser tab', () => {
    expect(readOverlayMode('', false)).toBe('interactive');
  });

  it('keeps the Simulation label unless the server reports live mode', () => {
    expect(showsSimulationLabel({ mode: 'simulation' })).toBe(true);
    expect(showsSimulationLabel(null)).toBe(true);
    expect(showsSimulationLabel('<!doctype html>')).toBe(true);
    expect(showsSimulationLabel({ mode: 'live' })).toBe(false);
  });

  it('keeps translations labeled while raids are real', () => {
    expect(simulationLabel({ mode: 'simulation', translation: 'simulated' })).toBe('Simulation');
    expect(simulationLabel(null)).toBe('Simulation');
    expect(simulationLabel({ mode: 'live', translation: 'simulated' })).toBe('Simulated translations');
    expect(simulationLabel({ mode: 'live' })).toBe('Simulated translations');
    expect(simulationLabel({ mode: 'live', translation: 'real' })).toBeNull();
  });
});

describe('raid text', () => {
  it('shows an explicit-action prompt for a browser winner and restores queued countdowns from snapshots', () => {
    const browser = chosen(started());
    const state = applyControlState(browser, { ...browser.roulette!, mode: 'manual' });
    expect(describeView(state, START, false).detail).toContain('explicit action');
    expect(describeView(state, START, false).detail).not.toContain('Requesting');
    const queued = applyControlState(state, {
      ...state.roulette!, status: 'raid_pending', raidRequestedAtMs: START, estimatedCountdownSeconds: 90,
    });
    expect(queued.raidArrivesAtMs).toBe(START + 90_000);
    expect(describeView(queued, START + 5_000, false).detail).toContain('85 s');
    expect(describeView(queued, START + 5_000, false).detail).toContain('not confirmed');
  });
  it('displays a browser winner in the read-only panel without chat voting rows', () => {
    const selected = chosen(started());
    const browser = { ...selected, roulette: { ...selected.roulette!, mode: 'manual' as const } };
    expect(describeRoulettePanel(browser)?.winner?.name).toBe('Demo rsdemo_ja_01');
    expect(describeRoulettePanel(browser)?.rows).toEqual([]);
  });
  it('says simulated by default and drops it only when told', () => {
    const pending = raidStarted(chosen(voted(started(), { ja: 1 })));
    expect(describeView(pending, START).detail).toContain('(simulated)');
    expect(describeView(pending, START, false).detail).not.toContain('simulated');
  });
});

describe('globe scene', () => {
  it('is empty without a session', () => {
    expect(globeScene(initialViewState)).toBe(EMPTY_SCENE);
  });

  it('marks every candidate during voting and spreads channels that share a country', () => {
    const scene = globeScene(started());
    expect(scene.points).toHaveLength(4);
    expect(scene.points.every((point) => point.kind === 'candidate')).toBe(true);
    const brazil = scene.points.filter((point) => Math.abs(point.lat - COUNTRY_POINTS.BR.lat) < 3);
    expect(brazil).toHaveLength(2);
    expect(brazil[0]).not.toEqual(brazil[1]);
    expect(scene.arcs).toEqual([]);
    expect(scene.animated).toBe(false);
    expect(scene.focus?.altitude).toBe(2.4);
  });

  it('highlights the winner, draws the route arc, and animates only while the raid is pending', () => {
    const chosenScene = globeScene(chosen(started()));
    expect(chosenScene.points.filter((point) => point.kind === 'chosen')).toHaveLength(1);
    expect(chosenScene.points.find((point) => point.kind === 'source')).toMatchObject(COUNTRY_POINTS.MX);
    expect(chosenScene.arcs).toEqual([{
      startLat: COUNTRY_POINTS.MX.lat, startLng: COUNTRY_POINTS.MX.lng,
      endLat: COUNTRY_POINTS.JP.lat, endLng: COUNTRY_POINTS.JP.lng, color: ['#6ce0a1', '#ffd166'],
    }]);
    expect(chosenScene.animated).toBe(false);

    const pending = globeScene(raidStarted(chosen(started())));
    expect(pending.animated).toBe(true);
    // Mexico to Japan crosses the Pacific, so the camera centres there, not on Europe.
    expect(Math.abs(pending.focus?.lng ?? 0)).toBeGreaterThan(150);
  });

  it('removes the route and highlight when the raid is cancelled', () => {
    const cancelled = applyEvent(raidStarted(chosen(started())), event('raid:cancelled', { reason: 'user_cancelled' }, { sessionId: SESSION }));
    const scene = globeScene(cancelled);
    expect(scene.arcs).toEqual([]);
    expect(scene.points.some((point) => point.kind !== 'candidate')).toBe(false);
    expect(scene.animated).toBe(false);
  });

  it('drops the route when a snapshot brings another session', () => {
    const other = applyEvent(chosen(started()), event('state:snapshot', {
      roulette: null, translationWindow: null,
    }));
    expect(other.route).toBeNull();
    expect(globeScene(other)).toBe(EMPTY_SCENE);
  });
});

describe('roulette panel', () => {
  it('groups channels by language with vote shares', () => {
    const panel = describeRoulettePanel(voted(started(), { ja: 1, pt: 3 }));
    expect(panel?.totalVotes).toBe(4);
    expect(panel?.rows.map((row) => [row.label, row.votes, row.share])).toEqual([
      ['Japanese', 1, 0.25], ['Portuguese', 3, 0.75], ['Korean', 0, 0],
    ]);
    expect(panel?.rows[1]?.channels).toEqual([
      { name: 'Demo rsdemo_pt_01', detail: '12 viewers · Synthetic Category' },
      { name: 'Demo rsdemo_pt_02', detail: '1 viewer · Synthetic Category' },
    ]);
    expect(panel?.winner).toBeNull();
  });

  it('shows the winner card and marks its language', () => {
    const panel = describeRoulettePanel(chosen(voted(started(), { ja: 2 })));
    expect(panel?.winner).toEqual({
      name: 'Demo rsdemo_ja_01', detail: '12 viewers · Synthetic Category', title: '[Synthetic] rsdemo_ja_01', language: 'Japanese',
    });
    expect(panel?.rows.filter((row) => row.chosen).map((row) => row.language)).toEqual(['ja']);
  });

  it('is hidden without a session and after a cancellation', () => {
    expect(describeRoulettePanel(initialViewState)).toBeNull();
    const cancelled = applyEvent(raidStarted(chosen(started())), event('raid:cancelled', { reason: 'user_cancelled' }, { sessionId: SESSION }));
    expect(describeRoulettePanel(cancelled)).toBeNull();
  });

  it('caps the channels listed per language', () => {
    const many = Array.from({ length: 5 }, (_, index) => candidate(`rsdemo_ja_0${index + 1}`, 'ja', 'JP'));
    const state = applyEvent(initialViewState, event('roulette:start', {
      candidates: many, languages: ['ja'], votingEndsAtMs: START + 30_000,
    }, { sessionId: SESSION }));
    const row = describeRoulettePanel(state)?.rows[0];
    expect(row?.channels).toHaveLength(3);
    expect(row?.more).toBe(2);
  });
});

describe('camera transition', () => {
  const from = { lat: 18, lng: -30, altitude: 2.35 };
  const to = { lat: 36.2, lng: 138.3, altitude: 1.7 };

  it('starts and ends exactly at the endpoints and clamps outside them', () => {
    expect(interpolateView(from, to, 0)).toEqual(from);
    expect(interpolateView(from, to, 1)).toMatchObject({ lat: 36.2, altitude: 1.7 });
    expect(interpolateView(from, to, 1).lng).toBeCloseTo(138.3);
    expect(interpolateView(from, to, -1)).toEqual(interpolateView(from, to, 0));
    expect(interpolateView(from, to, 2)).toEqual(interpolateView(from, to, 1));
  });

  it('takes the short way round the antimeridian', () => {
    const halfway = interpolateView({ lat: 0, lng: 170, altitude: 2 }, { lat: 0, lng: -170, altitude: 2 }, 0.5);
    expect(Math.abs(halfway.lng)).toBeCloseTo(180);
  });
});

describe('overlay markup', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const hiddenView = /<section id="roulette-view"[\s\S]*?<!-- Flag Competition Panel -->/.exec(html)?.[0] ?? '';

  it('keeps every session panel outside the hidden roulette view', () => {
    expect(hiddenView).not.toBe('');
    for (const id of ['roulette', 'bubbles', 'translation-window', 'headline']) {
      expect(html).toContain(`id="${id}"`);
      expect(hiddenView).not.toContain(`id="${id}"`);
    }
  });
  it('keeps a live status region, initially hidden Cancel, and the ordered controls in the roulette card', () => {
    expect(html).toMatch(/id="control-status" role="status" aria-live="polite"/);
    expect(html).toMatch(/id="cancel-raid"[^>]*disabled hidden/);
    const card = /<div class="roulette-card">[\s\S]*?<section class="control-feedback"/.exec(html)?.[0] ?? '';
    const ids = ['mode-manual', 'roulette-wheel-container', 'candidate-list', 'prepare-roulette', 'spin-roulette', 'raid-winner'];
    const positions = ids.map((id) => card.indexOf(`id="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  it('scopes the new layout and visibility rules to interactive mode, leaving OBS panels outside those rules', () => {
    const controlStyles = css.split('/* Broadcaster control room. OBS retains the original scene layout above. */')[1];
    expect(controlStyles).toBeDefined();
    const selectors = [...controlStyles!.matchAll(/([^{}]+)\{/g)].map((match) => match[1]!.trim()).filter((selector) => !selector.startsWith('@media'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) for (const part of selector.split(',')) {
      expect(part.trim().startsWith("html[data-mode='interactive']")).toBe(true);
    }
    expect(html).toMatch(/<section id="roulette" class="roulette"/);
    expect(html).toMatch(/<section class="translations"/);
    expect(html).toMatch(/<section id="session-status" class="status" aria-live="polite">/);
  });
});
