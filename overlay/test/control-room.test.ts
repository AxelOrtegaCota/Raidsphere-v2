import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateSchema, publicRouletteStateSchema } from '@raidsphere/shared';
import type { DiscoveryCandidate } from '@raidsphere/shared';
import { addManualCandidate, ControlFailure, outcomeText, selectView, sendControl } from '../src/control-room';
import { winnerRotation } from '../src/roulette-wheel';

afterEach(() => vi.restoreAllMocks());
const candidate: DiscoveryCandidate = {
  id: '2002', login: 'destination', displayName: '<img src=x onerror=alert(1)>', game: 'Fixture', title: 'Fixture',
  viewers: 10, language: 'it', thumbnailUrl: '', profileImageUrl: '', isLive: true,
};
function element() {
  const attributes = new Map<string, string>();
  return { hidden: false, disabled: false, classList: { toggle: vi.fn() }, attributes,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
}

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
