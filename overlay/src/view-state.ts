import type { IllustrativeCountry, PublicRouletteState, ServerEvent } from '@raidsphere/shared';

// Overlay display state, derived only from validated server events. The backend stays the
// authoritative state owner; this mirror never decides anything.

export interface ViewState {
  roulette: PublicRouletteState | null;
  raidArrivesAtMs: number | null;
  arrival: { fromLogin: string; viewers: number } | null;
  notice: string | null;
  // Illustrative countries for the globe arc; known only from roulette:chosen.
  route: { from: IllustrativeCountry | null; to: IllustrativeCountry | null } | null;
}

export const initialViewState: ViewState = {
  roulette: null, raidArrivesAtMs: null, arrival: null, notice: null, route: null,
};

export function applyEvent(state: ViewState, event: ServerEvent): ViewState {
  switch (event.type) {
    case 'state:snapshot':
      // A snapshot of another session drops the route that belonged to the previous one.
      return {
        ...state, roulette: event.payload.roulette, notice: null,
        route: event.payload.roulette?.sessionId === state.roulette?.sessionId ? state.route : null,
      };
    case 'roulette:start':
      return {
        ...initialViewState,
        roulette: {
          sessionId: event.sessionId, fromStreamerId: event.channelId, status: 'voting',
          candidates: event.payload.candidates, votes: {}, createdAtMs: event.occurredAtMs,
          votingEndsAtMs: event.payload.votingEndsAtMs, chosenCandidate: null,
        },
      };
    case 'roulette:votes':
      return updateSession(state, event.sessionId, { votes: event.payload.votes });
    case 'roulette:chosen': {
      const next = updateSession(state, event.sessionId, { status: 'chosen', chosenCandidate: event.payload.candidate });
      return next === state ? state : { ...next, route: { from: event.payload.fromCountry, to: event.payload.toCountry } };
    }
    case 'raid:started': {
      const { requestedAtMs, estimatedCountdownSeconds } = event.payload;
      const next = updateSession(state, event.sessionId, { status: 'raid_pending' });
      return next === state ? state : {
        ...next,
        raidArrivesAtMs: estimatedCountdownSeconds === null ? null : requestedAtMs + estimatedCountdownSeconds * 1_000,
      };
    }
    case 'raid:cancelled':
      return updateSession(state, event.sessionId, { status: 'cancelled' });
    case 'raid:arrived':
      return { ...state, arrival: { fromLogin: event.payload.fromLogin, viewers: event.payload.viewers }, notice: null };
    case 'error':
      if (event.payload.code === 'RAID_REJECTED') return updateSession(state, event.sessionId, { status: 'failed' });
      if (event.payload.code === 'RAID_OUTCOME_UNKNOWN') return updateSession(state, event.sessionId, { status: 'unknown' });
      if (event.payload.code === 'NO_ELIGIBLE_CANDIDATES') return { ...state, notice: 'No eligible channel is live right now.' };
      return state;
    default:
      return state;
  }
}

// The countdown text changes every second only in these states.
export function needsTick(state: ViewState): boolean {
  return state.roulette?.status === 'voting' || state.roulette?.status === 'raid_pending';
}

// Raids count as simulated unless the server positively reports otherwise.
export function describeView(state: ViewState, nowMs: number, simulated = true): { headline: string; detail: string } {
  const label = simulated ? ' (simulated)' : '';
  if (state.arrival) {
    return {
      headline: `Raid arrived from ${state.arrival.fromLogin}`,
      detail: `${state.arrival.viewers} viewers joined${label}.`,
    };
  }
  const roulette = state.roulette;
  if (!roulette) return { headline: 'Waiting for !roulette', detail: state.notice ?? '' };
  const target = roulette.chosenCandidate;
  switch (roulette.status) {
    case 'voting':
      return {
        headline: `Voting: ${secondsUntil(roulette.votingEndsAtMs, nowMs)} s left`,
        detail: [...new Set(roulette.candidates.map((candidate) => candidate.language))]
          .map((language) => `${language} ${roulette.votes[language] ?? 0}`).join(' · '),
      };
    case 'selecting':
      return { headline: 'Selecting a channel', detail: '' };
    case 'chosen':
      return { headline: `Chosen: ${target?.displayName ?? 'unknown'} (${target?.language ?? '?'})`, detail: `Requesting the raid${label}.` };
    case 'raid_pending':
      return {
        headline: `Raid to ${target?.displayName ?? 'unknown'}`,
        detail: state.raidArrivesAtMs === null
          ? `Waiting for the arrival${label}.`
          : `Arriving in about ${secondsUntil(state.raidArrivesAtMs, nowMs)} s${label}.`,
      };
    case 'done':
      return { headline: `Raid arrived at ${target?.displayName ?? 'the destination'}`, detail: `Arrival confirmed${label}.` };
    case 'cancelled':
      return { headline: 'Roulette cancelled', detail: state.notice ?? '' };
    case 'failed':
      return { headline: 'Raid request rejected', detail: state.notice ?? '' };
    case 'unknown':
      return { headline: 'Raid outcome not confirmed', detail: 'The arrival could not be confirmed.' };
  }
}

// Events for another (or no) session never change the displayed session.
function updateSession(state: ViewState, sessionId: string | undefined, changes: Partial<PublicRouletteState>): ViewState {
  if (!state.roulette || sessionId === undefined || state.roulette.sessionId !== sessionId) return state;
  return { ...state, roulette: { ...state.roulette, ...changes } };
}

function secondsUntil(targetMs: number | null, nowMs: number): number {
  return targetMs === null ? 0 : Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
}
