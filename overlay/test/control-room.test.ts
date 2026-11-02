import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateSchema, publicRouletteStateSchema } from '@raidsphere/shared';
import type { DiscoveryCandidate } from '@raidsphere/shared';
import { addManualCandidate, ControlFailure, createControlRoom, highlightNextAction, outcomeText, selectView, sendControl, statusPollText } from '../src/control-room';
import { winnerRotation } from '../src/roulette-wheel';

const stopViews: Array<() => void> = [];
afterEach(() => {
  for (const stop of stopViews.splice(0)) stop();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const candidate: DiscoveryCandidate = {
  id: '2002', login: 'destination', displayName: '<img src=x onerror=alert(1)>', game: 'Fixture', title: 'Fixture',
  viewers: 10, language: 'it', thumbnailUrl: '', profileImageUrl: '', isLive: true,
};
function element() {
  const attributes = new Map<string, string>();
  return { hidden: false, disabled: false, classList: { toggle: vi.fn() }, attributes,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
}

// A small DOM stand-in exercises the real polling/rendering code without a new dependency.
class ControlElement {
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  value = '6';
  type = '';
  dataset: Record<string, string> = {};
  children: ControlElement[] = [];
  attributes = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(event: unknown) => void>>();
  focus = vi.fn();
  classList = {
    toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  append(...children: ControlElement[]): void { this.children.push(...children); }
  replaceChildren(...children: ControlElement[]): void { this.children = [...children]; }
  getContext(): null { return null; } // Text fallback models a browser without Canvas in these DOM tests.
  fire(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  click(): void { if (!this.disabled) this.fire('click'); }
}
const idleStatus = { channelId: '1001', login: 'fixturecaster', isLive: true, viewers: 100, simulated: true, roulette: null };
function room() {
  vi.useFakeTimers();
  const selectors = new Map<string, ControlElement>();
  for (const selector of ['#globe-view', '#roulette-view', '#view-globe', '#view-roulette', '#mode-manual', '#mode-auto', '#auto-count',
    '#prepare-roulette', '#spin-roulette', '#raid-winner', '#cancel-raid', '#candidate-list', '#control-status',
    '#roulette-wheel-container', '#roulette-wheel-empty', '#roulette-wheel-hint', '#candidate-count', '.auto-count-label', '#manual-candidates']) {
    selectors.set(selector, new ControlElement());
  }
  const get = (selector: string): ControlElement => selectors.get(selector)!;
  get('#control-status').textContent = 'Checking your Twitch session…';
  let response: { status: number; body: unknown } = { status: 200, body: idleStatus };
  let postResponse: unknown = {};
  let postError: Error | null = null;
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (postError) throw postError;
      return new Response(JSON.stringify(postResponse), { status: 200 });
    }
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000002' });
  vi.stubGlobal('document', { createElement: () => new ControlElement() });
  vi.stubGlobal('window', {
    addEventListener: (type: string, callback: () => void) => { if (type === 'pagehide') stopViews.push(callback); },
    matchMedia: () => ({ matches: true }),
  });
  const onStatus = vi.fn();
  const controls = createControlRoom({ querySelector: (selector: string) => selectors.get(selector) ?? null } as unknown as HTMLElement,
    { onStatus, onState: vi.fn() });
  return {
    get, controls, fetchMock, onStatus,
    respond: (status: number, body: unknown) => { response = { status, body }; },
    post: (body: unknown) => { postResponse = body; },
    failPost: (error: Error) => { postError = error; },
  };
}

describe('successful status polling', () => {
  it('replaces Checking with the logged-in live ready message, including unchanged later polls', async () => {
    const h = room();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.get('#control-status').textContent).toBe('Live as fixturecaster · add channels or switch to Auto');
    h.get('#control-status').textContent = 'Stale message';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.get('#control-status').textContent).toBe('Live as fixturecaster · add channels or switch to Auto');
    expect(h.onStatus).toHaveBeenCalledWith(idleStatus);
    expect(h.get('#cancel-raid').hidden).toBe(true);
    expect(h.fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
  it.each([
    [401, 'Log in with Twitch from the dashboard to enable controls.'],
    [403, 'Log in with Twitch from the dashboard to enable controls.'],
    [503, 'Live source status could not be verified. Controls are disabled.'],
  ])('keeps the existing HTTP %i status message', async (status, message) => {
    const h = room();
    await vi.advanceTimersByTimeAsync(0);
    h.respond(status, {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.get('#control-status').textContent).toBe(message);
    expect(h.get('#cancel-raid').hidden).toBe(true);
  });
  it('reports offline on each successful poll and retains unresolved uncertainty across later live/offline polls', async () => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    h.failPost(new TypeError('Synthetic lost response'));
    await h.controls.raid(candidate);
    const uncertain = h.get('#control-status').textContent;
    expect(uncertain).toContain('Uncertain outcome. No retry was made.');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.get('#control-status').textContent).toBe(uncertain);
    h.respond(200, { ...idleStatus, isLive: false, viewers: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.get('#control-status').textContent).toContain('Your source stream is offline.');
    expect(h.get('#control-status').textContent).toContain(uncertain);
    expect(h.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('preserves the offline message without an action notice', () => {
    expect(statusPollText({ ...idleStatus, isLive: false })).toBe('Your source stream is offline. A raid requires a live source stream.');
  });
  it('refreshes unchanged outcome messages and hides Cancel after terminal outcomes', async () => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    const destination = candidateSchema.parse({
      streamerId: candidate.id, login: candidate.login, displayName: candidate.displayName, avatarUrl: null,
      language: candidate.language, illustrativeCountry: null, viewers: candidate.viewers, gameName: '', title: '',
    });
    for (const status of ['chosen', 'raid_pending', 'done', 'cancelled', 'failed', 'unknown'] as const) {
      const state = publicRouletteStateSchema.parse({
        sessionId: 'synthetic-session', fromStreamerId: '1001', mode: 'manual', status, candidates: [destination],
        votes: {}, createdAtMs: Date.now() - 1_000, votingEndsAtMs: null, chosenCandidate: destination,
      });
      h.respond(200, { ...idleStatus, roulette: state });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.get('#cancel-raid').hidden).toBe(!['chosen', 'raid_pending'].includes(status));
      h.get('#control-status').textContent = 'Stale outcome';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.get('#control-status').textContent).toBe(outcomeText(state, true));
    }
    expect(h.fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});

describe('control card presentation', () => {
  it.each([true, false])('preserves the simulated=%s winner raid label', async (simulated) => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    h.respond(200, { ...idleStatus, simulated });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.get('#raid-winner').textContent).toBe(simulated ? 'Simulate raid to winner' : 'Start Raid to winner');
  });
  it('shows empty states and compact removable rows using text content', async () => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    expect(h.get('#candidate-list').children[0]?.textContent).toContain('No channels selected');
    expect(h.get('#roulette-wheel-empty').hidden).toBe(false);
    for (const id of ['2002', '2003', '2004']) h.controls.add({ ...candidate, id });
    const list = h.get('#candidate-list');
    expect(list.children).toHaveLength(3);
    expect(list.children[0]?.children[0]?.textContent).toContain(candidate.displayName);
    expect(h.get('#candidate-count').textContent).toBe('3 channels');
    expect(h.get('#prepare-roulette').classes.has('is-primary')).toBe(true);
    list.children[0]?.children[1]?.click();
    expect(h.get('#candidate-list').children).toHaveLength(2);
    expect(h.get('#candidate-count').textContent).toBe('2 channels');
  });
  it('shows the count selector only in Auto and keeps native arrow-key navigation', async () => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    expect(h.get('#auto-count').hidden).toBe(true);
    h.get('#mode-auto').click();
    expect(h.get('#auto-count').hidden).toBe(false);
    expect(h.get('.auto-count-label').hidden).toBe(false);
    expect(h.get('#prepare-roulette').classes.has('is-primary')).toBe(true);
    h.get('#view-globe').fire('keydown', { key: 'ArrowRight', preventDefault: vi.fn() });
    expect(h.get('#roulette-view').hidden).toBe(false);
    expect(h.get('#view-roulette').focus).toHaveBeenCalledOnce();
  });
  it('highlights Spin after one preparation request without altering the request payload', async () => {
    const h = room(); await vi.advanceTimersByTimeAsync(0);
    h.controls.add(candidate);
    const destination = candidateSchema.parse({
      streamerId: candidate.id, login: candidate.login, displayName: candidate.displayName, avatarUrl: null, language: candidate.language,
      illustrativeCountry: null, viewers: candidate.viewers, gameName: candidate.game, title: candidate.title,
    });
    h.post({
      poolId: '00000000-0000-4000-8000-000000000001', mode: 'manual', candidates: [destination],
      sourceViewers: 100, minViewers: 50, maxViewers: 200, discoveryLimited: false, expiresAtMs: Date.now() + 120_000,
    });
    h.get('#prepare-roulette').click(); await vi.advanceTimersByTimeAsync(0);
    expect(h.get('#spin-roulette').classes.has('is-primary')).toBe(true);
    expect(h.get('#prepare-roulette').classes.has('is-primary')).toBe(false);
    const posts = h.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ channelId: '1001', mode: 'manual', candidateIds: ['2002'] });
  });
  it('highlights only the furthest available step and never highlights a disabled action', () => {
    const buttons = [new ControlElement(), new ControlElement(), new ControlElement()];
    const actions = buttons as unknown as HTMLButtonElement[];
    buttons[2]!.disabled = true; highlightNextAction(actions);
    expect(buttons.map((button) => button.classes.has('is-primary'))).toEqual([false, true, false]);
    buttons[2]!.disabled = false; highlightNextAction(actions);
    expect(buttons.map((button) => button.classes.has('is-primary'))).toEqual([false, false, true]);
    for (const button of buttons) button.disabled = true;
    highlightNextAction(actions);
    expect(buttons.every((button) => !button.classes.has('is-primary'))).toBe(true);
  });
});

describe('Globe and Roulette navigation', () => {
  it('selects one panel and updates both pressed states, including the initial Globe view', () => {
    const globe = element(); const roulette = element(); const globeButton = element(); const rouletteButton = element();
    const views = { globe, roulette, globeButton, rouletteButton } as unknown as Parameters<typeof selectView>[0];
    selectView(views, 'globe', true);
    expect(globe.hidden).toBe(false); expect(roulette.hidden).toBe(true);
    expect(globeButton.attributes.get('aria-pressed')).toBe('true'); expect(rouletteButton.attributes.get('aria-pressed')).toBe('false');
    selectView(views, 'roulette', true);
    expect(globe.hidden).toBe(true); expect(roulette.hidden).toBe(false);
    expect(globeButton.attributes.get('aria-pressed')).toBe('false'); expect(rouletteButton.attributes.get('aria-pressed')).toBe('true');
  });
  it('cannot reveal Roulette controls in OBS mode', () => {
    const globe = element(); const roulette = element(); const globeButton = element(); const rouletteButton = element();
    selectView({ globe, roulette, globeButton, rouletteButton } as unknown as Parameters<typeof selectView>[0], 'roulette', false);
    expect(globe.hidden).toBe(false); expect(roulette.hidden).toBe(true);
    expect(globeButton.disabled).toBe(true); expect(rouletteButton.disabled).toBe(true);
  });
});

describe('manual selections', () => {
  it('preserves external strings as data and suppresses duplicate identities', () => {
    const selected = addManualCandidate([], candidate, '1001');
    expect(addManualCandidate(selected, candidate, '1001')).toEqual([candidate]);
    expect(selected[0]?.displayName).toBe(candidate.displayName);
    expect(selected.filter((entry) => entry.id !== '2002')).toEqual([]);
  });
  it('rejects offline, self, and malformed destinations', () => {
    expect(() => addManualCandidate([], { ...candidate, isLive: false }, '1001')).toThrow();
    expect(() => addManualCandidate([], candidate, '2002')).toThrow();
    expect(() => addManualCandidate([], { ...candidate, login: '../invalid' }, '1001')).toThrow();
  });
});

describe('authenticated control transport', () => {
  it('sends exactly one cookie-authenticated POST without a viewing credential or winner override', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const body = { channelId: '1001', requestId: '00000000-0000-4000-8000-000000000001', poolId: '00000000-0000-4000-8000-000000000002' };
    await sendControl('/api/control/spin', body, fetchMock);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error', body: JSON.stringify(body), headers: { 'X-RaidSphere-Control': '1' } });
    expect(JSON.stringify(body)).not.toContain('winner'); expect(JSON.stringify(body)).not.toContain('credential');
  });
  it.each([400, 401, 403, 404, 409, 429, 500, 503])('classifies HTTP %i and never retries', async (status) => {
    const fetchMock = vi.fn(async () => new Response('{"error":"Fixture refusal"}', { status }));
    try { await sendControl('/api/control/raid', {}, fetchMock); throw new Error('Expected refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(ControlFailure);
      expect((error as ControlFailure).uncertain).toBe(status >= 500);
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([new TypeError('network'), new DOMException('timeout', 'TimeoutError')])('keeps a failed request uncertain without retry', async (failure) => {
    const fetchMock = vi.fn(async () => { throw failure; });
    await expect(sendControl('/api/control/raid', {}, fetchMock)).rejects.toMatchObject({ status: 0, uncertain: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('server-selected wheel and outcomes', () => {
  it('lands every winner at the pointer after arbitrary previous rotations', () => {
    const tau = Math.PI * 2;
    for (const count of [1, 6, 7]) for (let index = 0; index < count; index += 1) {
      const rotation = winnerRotation(23.7, index, count);
      expect(rotation).toBeGreaterThan(23.7 + 5 * tau);
      const center = rotation + (index + 0.5) * tau / count;
      expect(Math.abs(Math.sin(center))).toBeLessThan(0.000001);
      expect(Math.cos(center)).toBeCloseTo(1);
    }
    expect(() => winnerRotation(0, 7, 7)).toThrow();
  });
  it('does not describe a chosen or queued raid as an arrival and labels simulation', () => {
    const chosenCandidate = candidateSchema.parse({
      streamerId: '2002', login: candidate.login, displayName: candidate.displayName, avatarUrl: null, language: 'it',
      illustrativeCountry: null, viewers: 10, gameName: '', title: '',
    });
    const state = publicRouletteStateSchema.parse({
      sessionId: 'fixture-session', fromStreamerId: '1001', mode: 'manual', status: 'chosen', candidates: [chosenCandidate],
      votes: {}, createdAtMs: 1_000, votingEndsAtMs: null, chosenCandidate,
    });
    expect(outcomeText(state, false)).toContain('No raid has been requested');
    expect(outcomeText({ ...state, raidRequestedAtMs: 1_000 }, false)).toContain('Submitting one raid request');
    expect(outcomeText({ ...state, status: 'raid_pending' }, false)).toContain('acceptance is not arrival');
    expect(outcomeText({ ...state, status: 'unknown' }, false)).toContain('uncertain');
    expect(outcomeText({ ...state, status: 'done' }, true)).toContain('(simulation)');
  });
});
