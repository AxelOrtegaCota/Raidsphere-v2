import {
  controlResultSchema, controlStatusSchema, discoveryCandidateSchema, preparedRouletteSchema,
} from '@raidsphere/shared';
import type { DiscoveryCandidate, PublicRouletteState } from '@raidsphere/shared';
import { createRouletteWheel, type RouletteWheel } from './roulette-wheel';

type ControlStatus = ReturnType<typeof controlStatusSchema.parse>;
type Prepared = ReturnType<typeof preparedRouletteSchema.parse>;
type ViewElements = { globe: HTMLElement; roulette: HTMLElement; globeButton: HTMLButtonElement; rouletteButton: HTMLButtonElement };

export function statusPollText(status: ControlStatus, notice: string | null = null): string {
  const offline = 'Your source stream is offline. A raid requires a live source stream.';
  if (notice) return status.isLive ? notice : `${offline} ${notice}`;
  if (!status.isLive) return offline;
  return status.roulette ? outcomeText(status.roulette, status.simulated)
    : `Live as ${status.login} · add channels or switch to Auto`;
}

// Presentation only: OBS continues to own the existing headline and session panels.
export function presentSessionPanel(panel: HTMLElement, mode: 'interactive' | 'obs', state: PublicRouletteState | null): void {
  if (mode === 'obs') return;
  panel.hidden = state === null;
  panel.dataset.hasSession = String(state !== null);
}

export function highlightNextAction(actions: readonly HTMLButtonElement[]): void {
  const next = [...actions].reverse().find((action) => !action.disabled);
  for (const action of actions) action.classList.toggle('is-primary', action === next);
}

export function selectView(elements: ViewElements, selected: 'globe' | 'roulette', interactive: boolean): void {
  const globe = !interactive || selected === 'globe';
  elements.globe.hidden = !globe;
  elements.roulette.hidden = globe;
  elements.globe.classList.toggle('active', globe);
  elements.roulette.classList.toggle('active', !globe);
  elements.globeButton.setAttribute('aria-pressed', String(globe));
  elements.rouletteButton.setAttribute('aria-pressed', String(!globe));
  elements.globeButton.classList.toggle('active', globe);
  elements.rouletteButton.classList.toggle('active', !globe);
  elements.globeButton.disabled = !interactive;
  elements.rouletteButton.disabled = !interactive;
}

export function addManualCandidate(current: readonly DiscoveryCandidate[], input: DiscoveryCandidate, sourceId: string): DiscoveryCandidate[] {
  const candidate = discoveryCandidateSchema.parse(input);
  if (!candidate.isLive || candidate.id === sourceId) throw new Error('Select another live channel.');
  if (current.some((entry) => entry.id === candidate.id)) return [...current];
  if (current.length >= 100) throw new Error('The maximum is 100 manual candidates.');
  return [...current, candidate];
}

export class ControlFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
  get uncertain(): boolean { return this.status === 0 || this.status >= 500; }
}

// Exactly one POST. Read-only status polling is separate and never repeats an action.
export async function sendControl(path: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-RaidSphere-Control': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35_000),
    });
  } catch { throw new ControlFailure(0, 'The request outcome is uncertain. Check the session and Twitch before taking another raid action.'); }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
      ? data.error.slice(0, 300) : 'The control request was rejected.';
    throw new ControlFailure(response.status, message);
  }
  return data;
}

export function createControlRoom(root: HTMLElement, options: {
  onState: (roulette: PublicRouletteState | null, simulated: boolean) => void;
  onStatus: (status: ControlStatus | null) => void;
}): { add: (candidate: DiscoveryCandidate) => void; raid: (candidate: DiscoveryCandidate) => Promise<void> } {
  const required = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing control element: ${selector}`);
    return element;
  };
  const views: ViewElements = {
    globe: required('#globe-view'), roulette: required('#roulette-view'),
    globeButton: required('#view-globe'), rouletteButton: required('#view-roulette'),
  };
  const manual = required<HTMLButtonElement>('#mode-manual');
  const auto = required<HTMLButtonElement>('#mode-auto');
  const count = required<HTMLSelectElement>('#auto-count');
  const prepare = required<HTMLButtonElement>('#prepare-roulette');
  const spin = required<HTMLButtonElement>('#spin-roulette');
  const raidWinner = required<HTMLButtonElement>('#raid-winner');
  const cancel = required<HTMLButtonElement>('#cancel-raid');
  const list = required<HTMLUListElement>('#candidate-list');
  const message = required('#control-status');
  const wheelContainer = required('#roulette-wheel-container');
  const wheelEmpty = required('#roulette-wheel-empty');
  const wheelHint = required('#roulette-wheel-hint');
  const candidateCount = required('#candidate-count');
  let status: ControlStatus | null = null;
  let selected: DiscoveryCandidate[] = [];
  let mode: 'manual' | 'auto' = 'manual';
  let prepared: Prepared | null = null;
  let busy = false;
  let uncertainRaid = false;
  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let wheel: RouletteWheel | null = null;
  let displayedSession: string | null = null;
  let actionNotice: string | null = null;
  const colors = ['#7257d9', '#c94882', '#327fba', '#3b947a', '#af772c', '#7666b1', '#bd5845'];

  selectView(views, 'globe', true);
  views.globeButton.addEventListener('click', () => selectView(views, 'globe', true));
  views.rouletteButton.addEventListener('click', () => selectView(views, 'roulette', true));
  // Native buttons already support Tab, Enter and Space; arrows also switch and focus.
  for (const button of [views.globeButton, views.rouletteButton]) button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const globe = event.key === 'Home' || event.key === 'ArrowLeft';
    selectView(views, globe ? 'globe' : 'roulette', true);
    (globe ? views.globeButton : views.rouletteButton).focus();
  });

  const sessionBusy = (): boolean => Boolean(status?.roulette && ['voting', 'selecting', 'chosen', 'raid_pending', 'unknown'].includes(status.roulette.status));
  const render = (): void => {
    const canPrepare = Boolean(status?.isLive) && !busy && !uncertainRaid && !sessionBusy();
    manual.setAttribute('aria-pressed', String(mode === 'manual'));
    auto.setAttribute('aria-pressed', String(mode === 'auto'));
    manual.classList.toggle('active', mode === 'manual');
    auto.classList.toggle('active', mode === 'auto');
    manual.disabled = busy;
    auto.disabled = busy;
    count.hidden = mode !== 'auto';
    required('.auto-count-label').hidden = mode !== 'auto';
    count.disabled = busy;
    required('#manual-candidates').hidden = false;
    prepare.disabled = !canPrepare || (mode === 'manual' && selected.length === 0);
    spin.disabled = !canPrepare || !prepared?.candidates.length || prepared.expiresAtMs <= Date.now();
    raidWinner.disabled = !status?.isLive || busy || uncertainRaid || status.roulette?.status !== 'chosen' ||
      status.roulette?.raidRequestedAtMs !== undefined ||
      !['manual', 'auto'].includes(status.roulette?.mode ?? 'chat');
    raidWinner.textContent = status?.simulated === false ? 'Start Raid to winner' : 'Simulate raid to winner';
    cancel.disabled = busy || !status?.roulette || !['voting', 'chosen', 'raid_pending'].includes(status.roulette.status);
    cancel.hidden = !status?.roulette || !['voting', 'chosen', 'raid_pending'].includes(status.roulette.status);
    highlightNextAction([prepare, spin, raidWinner]);
    list.replaceChildren();
    const entries = prepared?.candidates ?? (mode === 'manual' ? selected.map((candidate) => ({ streamerId: candidate.id, displayName: candidate.displayName, viewers: candidate.viewers })) : []);
    const sessionCandidates = status?.roulette && ['manual', 'auto'].includes(status.roulette.mode ?? 'chat')
      ? status.roulette.candidates : [];
    const shownEntries = entries.length ? entries : sessionCandidates;
    candidateCount.textContent = `${shownEntries.length} ${shownEntries.length === 1 ? 'channel' : 'channels'}`;
    if (!shownEntries.length) {
      const empty = document.createElement('li');
      empty.className = 'candidate-selection-empty';
      empty.textContent = mode === 'manual' ? 'No channels selected. Add live channels from the right panel.'
        : 'Prepare Auto to find live channels in the required viewer range.';
      list.append(empty);
    }
    wheelEmpty.hidden = displayedSession !== null;
    wheelContainer.hidden = displayedSession === null;
    wheelHint.textContent = prepared?.candidates.length
      ? `${prepared.candidates.length} live candidates prepared. Spin to reveal the server-selected winner.`
      : shownEntries.length ? `${shownEntries.length} channels selected. Prepare candidates before spinning.`
      : mode === 'manual' ? 'Add live channels from the right panel' : 'Prepare Auto to discover your candidates';
    for (const candidate of shownEntries) {
      const item = document.createElement('li');
      item.className = 'candidate-selection-item';
      const name = document.createElement('span');
      name.textContent = `${candidate.displayName} · ${candidate.viewers} viewers`;
      item.append(name);
      if (mode === 'manual' && selected.some((entry) => entry.id === candidate.streamerId)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${candidate.displayName}`);
        remove.disabled = busy;
        remove.addEventListener('click', () => {
          selected = selected.filter((entry) => entry.id !== candidate.streamerId);
          prepared = null;
          if (!uncertainRaid) actionNotice = null;
          render();
        });
        item.append(remove);
      }
      list.append(item);
    }
  };

  const displayWinner = async (state: PublicRouletteState, animate: boolean): Promise<void> => {
    if (!state.chosenCandidate || !['manual', 'auto'].includes(state.mode ?? 'chat') || displayedSession === state.sessionId) return;
    displayedSession = state.sessionId;
    wheelEmpty.hidden = true;
    wheelContainer.hidden = false;
    wheel?.destroy();
    wheel = null;
    try {
      wheel = createRouletteWheel(wheelContainer, {
        candidates: state.candidates.map((candidate, index) => ({
          id: candidate.streamerId, displayName: candidate.displayName, color: colors[index % colors.length]!,
          ...(candidate.avatarUrl ? { avatarUrl: candidate.avatarUrl } : {}),
        })),
        spinDurationMs: animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 5_000 : 1,
      });
      await wheel.spin(state.chosenCandidate.streamerId);
    } catch {
      wheelContainer.textContent = `Winner: ${state.chosenCandidate.displayName}`;
    }
  };

  const updateState = (state: PublicRouletteState, simulated: boolean): void => {
    if (!status) return;
    status = { ...status, roulette: state, simulated };
    options.onState(state, simulated);
    render();
  };

  const act = async (kind: 'prepare' | 'spin' | 'raid' | 'cancel', body: unknown): Promise<void> => {
    if (busy || !status) return;
    if ((kind === 'raid' || kind === 'spin') && uncertainRaid) return;
    busy = true;
    actionNotice = null;
    message.textContent = kind === 'raid' ? 'Submitting one raid request. Acceptance does not confirm arrival.' : 'Working…';
    render();
    try {
      const raw = await sendControl(`/api/control/${kind}`, body);
      if (kind === 'prepare') {
        prepared = preparedRouletteSchema.parse(raw);
        message.textContent = `${prepared.candidates.length} live candidates available${prepared.mode === 'auto' ? ` within ${prepared.minViewers}–${prepared.maxViewers} viewers` : ''}.${prepared.discoveryLimited ? ' Discovery reached its page limit; this is the available count among inspected streams.' : ''}`;
      } else {
        const response = controlResultSchema.parse(raw);
        updateState(response.roulette, response.simulated);
        uncertainRaid = false;
        message.textContent = response.roulette.status === 'chosen'
          ? `Winner: ${response.roulette.chosenCandidate?.displayName}. Start Raid is a separate explicit action.`
          : outcomeText(response.roulette, response.simulated);
        if (kind === 'spin') await displayWinner(response.roulette, true);
      }
    } catch (error) {
      const uncertain = !(error instanceof ControlFailure) || error.uncertain;
      if ((kind === 'raid' || kind === 'cancel') && uncertain) uncertainRaid = true;
      actionNotice = `${uncertain && (kind === 'raid' || kind === 'cancel') ? 'Uncertain outcome. No retry was made. ' : 'Request rejected. '}${error instanceof Error ? error.message : 'The response could not be verified.'}`;
      message.textContent = actionNotice;
    } finally { busy = false; render(); }
  };

  const chooseMode = (next: typeof mode): void => { if (!busy) { mode = next; prepared = null; if (!uncertainRaid) actionNotice = null; render(); } };
  manual.addEventListener('click', () => chooseMode('manual'));
  auto.addEventListener('click', () => chooseMode('auto'));
  count.addEventListener('change', () => { prepared = null; render(); });
  prepare.addEventListener('click', () => {
    if (!status) return;
    void act('prepare', mode === 'manual'
      ? { channelId: status.channelId, mode, candidateIds: selected.map((candidate) => candidate.id) }
      : { channelId: status.channelId, mode, count: Number(count.value) });
  });
  spin.addEventListener('click', () => {
    if (status && prepared) void act('spin', { channelId: status.channelId, poolId: prepared.poolId, requestId: crypto.randomUUID() });
  });
  raidWinner.addEventListener('click', () => {
    if (status?.roulette) void act('raid', { channelId: status.channelId, sessionId: status.roulette.sessionId, requestId: crypto.randomUUID() });
  });
  cancel.addEventListener('click', () => {
    if (status?.roulette) void act('cancel', { channelId: status.channelId, sessionId: status.roulette.sessionId, requestId: crypto.randomUUID() });
  });

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      // Do not let an older GET overwrite a just-completed POST or interrupt animation.
      if (busy) return;
      const response = await fetch('/api/control/status', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          status = null; options.onStatus(null); message.textContent = 'Log in with Twitch from the dashboard to enable controls.';
        } else { status = null; options.onStatus(null); message.textContent = 'Live source status could not be verified. Controls are disabled.'; }
        return;
      }
      const next = controlStatusSchema.parse(await response.json());
      if (busy) return;
      const previous = status?.roulette;
      const ownerChanged = status !== null && status.channelId !== next.channelId;
      if (ownerChanged) { selected = []; prepared = null; uncertainRaid = false; displayedSession = null; actionNotice = null; }
      status = next;
      options.onStatus(next);
      options.onState(next.roulette, next.simulated);
      if (next.roulette && ['raid_pending', 'done', 'failed', 'unknown', 'cancelled'].includes(next.roulette.status)) uncertainRaid = false;
      if (!uncertainRaid && (previous?.status !== next.roulette?.status || previous?.sessionId !== next.roulette?.sessionId)) actionNotice = null;
      // Always resolve the initial checking message, including a live, idle broadcaster.
      message.textContent = statusPollText(next, actionNotice);
      if (next.roulette) void displayWinner(next.roulette, false);
    } catch {
      if (!busy) { status = null; options.onStatus(null); message.textContent = 'Live status is unavailable. No control request was retried.'; }
    } finally {
      polling = false;
      render();
      if (!stopped) pollTimer = setTimeout(() => { void poll(); }, 5_000);
    }
  };
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); wheel?.destroy(); }, { once: true });
  render();
  void poll();
  return {
    add: (candidate) => {
      if (!status || busy) { message.textContent = 'Log in and wait for the current action to finish.'; return; }
      try {
        selected = addManualCandidate(selected, candidate, status.channelId);
        mode = 'manual'; prepared = null;
        if (!uncertainRaid) actionNotice = null;
        message.textContent = `${selected.length} manual candidates selected. Prepare candidates before spinning.`;
        selectView(views, 'roulette', true);
        render();
      } catch (error) { message.textContent = error instanceof Error ? error.message : 'Invalid candidate.'; }
    },
    raid: async (candidate) => {
      if (!status?.isLive || busy || sessionBusy() || uncertainRaid) {
        message.textContent = 'A live authenticated source and no active or uncertain session are required. Finish or cancel the current session first.';
        return;
      }
      const validated = discoveryCandidateSchema.safeParse(candidate);
      if (!validated.success || !validated.data.isLive || candidate.id === status.channelId) { message.textContent = 'Choose another live destination.'; return; }
      await act('raid', { channelId: status.channelId, toStreamerId: candidate.id, requestId: crypto.randomUUID() });
    },
  };
}

export function outcomeText(state: PublicRouletteState, simulated: boolean): string {
  const label = simulated ? ' (simulation)' : '';
  switch (state.status) {
    case 'chosen': return state.raidRequestedAtMs === undefined
      ? `Winner: ${state.chosenCandidate?.displayName}. No raid has been requested${label}.`
      : `Submitting one raid request${label}. The outcome is not confirmed.`;
    case 'raid_pending': return `Raid queued${label}. Waiting for confirmed arrival; acceptance is not arrival.`;
    case 'done': return `Arrival confirmed${label}.`;
    case 'cancelled': return `Session cancelled${label}.`;
    case 'failed': return `Raid rejected${label}.`;
    case 'unknown': return `Raid outcome uncertain${label}. Check Twitch; do not repeat the request.`;
    default: return 'Chat roulette is active. Browser spins are separate from chat voting.';
  }
}
