import type { Candidate, IllustrativeCountry } from '@raidsphere/shared';
import type { ViewState } from './view-state';

// Globe scene derived from the session (Phase 2, Module A). Countries are illustrative: a
// channel's language suggests a country, never its real location, so each one maps to a fixed
// representative point.

export const COUNTRY_POINTS: Readonly<Record<IllustrativeCountry, { lat: number; lng: number }>> = {
  US: { lat: 39.8, lng: -98.6 },
  MX: { lat: 23.6, lng: -102.5 },
  BR: { lat: -10.3, lng: -53.2 },
  FR: { lat: 46.6, lng: 2.4 },
  DE: { lat: 51.2, lng: 10.4 },
  JP: { lat: 36.2, lng: 138.3 },
  KR: { lat: 36.5, lng: 127.9 },
};

const COLORS = { candidate: '#9f87ff', chosen: '#ffd166', dimmed: 'rgba(159, 135, 255, 0.35)', source: '#6ce0a1' } as const;
// Spreads channels that share a country so their markers stay distinct.
const SPREAD_DEGREES = 2.2;

export interface GlobePoint {
  lat: number;
  lng: number;
  color: string;
  radius: number;
  kind: 'candidate' | 'chosen' | 'source';
}

export interface GlobeArc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: [string, string];
}

export interface GlobeScene {
  points: GlobePoint[];
  arcs: GlobeArc[];
  focus: { lat: number; lng: number; altitude: number } | null;
  // Only an in-flight raid animates; every other scene can pause rendering.
  animated: boolean;
}

export const EMPTY_SCENE: GlobeScene = { points: [], arcs: [], focus: null, animated: false };

export function globeScene(state: ViewState): GlobeScene {
  const roulette = state.roulette;
  if (!roulette) return EMPTY_SCENE;
  const chosenId = roulette.chosenCandidate?.streamerId ?? null;
  const settled = roulette.status === 'cancelled' || roulette.status === 'failed' || roulette.status === 'unknown';
  const points: GlobePoint[] = candidatePoints(roulette.candidates).map(({ candidate, point }): GlobePoint => {
    const chosen = candidate.streamerId === chosenId && !settled;
    const color = chosen ? COLORS.chosen : chosenId !== null || settled ? COLORS.dimmed : COLORS.candidate;
    return { ...point, color, radius: chosen ? 0.9 : 0.55, kind: chosen ? 'chosen' : 'candidate' };
  });

  const from = state.route?.from ? COUNTRY_POINTS[state.route.from] : null;
  const toCountry = state.route?.to ?? roulette.chosenCandidate?.illustrativeCountry ?? null;
  const to = toCountry ? COUNTRY_POINTS[toCountry] : null;
  const routeShown = chosenId !== null && !settled;
  if (routeShown && from) points.push({ ...from, color: COLORS.source, radius: 0.7, kind: 'source' });
  const arcs: GlobeArc[] = routeShown && from && to
    ? [{ startLat: from.lat, startLng: from.lng, endLat: to.lat, endLng: to.lng, color: [COLORS.source, COLORS.chosen] }]
    : [];

  return { points, arcs, focus: focusFor(roulette.status, points, from, to), animated: roulette.status === 'raid_pending' && arcs.length > 0 };
}

function candidatePoints(candidates: readonly Candidate[]) {
  const seen = new Map<IllustrativeCountry, number>();
  return candidates.flatMap((candidate) => {
    if (!candidate.illustrativeCountry) return [];
    const base = COUNTRY_POINTS[candidate.illustrativeCountry];
    const index = seen.get(candidate.illustrativeCountry) ?? 0;
    seen.set(candidate.illustrativeCountry, index + 1);
    // The first channel sits on the point; later ones go round it.
    const angle = (index * 2 * Math.PI) / 6;
    const offset = index === 0 ? 0 : SPREAD_DEGREES;
    return [{ candidate, point: { lat: base.lat + offset * Math.sin(angle), lng: base.lng + offset * Math.cos(angle) } }];
  });
}

function focusFor(
  status: NonNullable<ViewState['roulette']>['status'],
  points: readonly GlobePoint[],
  from: { lat: number; lng: number } | null,
  to: { lat: number; lng: number } | null,
): GlobeScene['focus'] {
  if (status === 'done' && to) return { ...to, altitude: 1.7 };
  if ((status === 'chosen' || status === 'raid_pending') && to) {
    // A late viewer's snapshot has no source country, so the camera goes to the destination.
    return from ? { lat: (from.lat + to.lat) / 2, lng: midpointLng(from.lng, to.lng), altitude: 2.2 } : { ...to, altitude: 1.9 };
  }
  if (points.length === 0) return null;
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng, altitude: 2.4 };
}

// Takes the shorter way round, so a Pacific route is not centred on Europe.
function midpointLng(a: number, b: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  const mid = a + delta / 2;
  return ((mid + 540) % 360) - 180;
}

export interface CameraView {
  lat: number;
  lng: number;
  altitude: number;
}

// Camera position k of the way (0 to 1) along an eased path, the short way round in longitude.
// globe.gl 2.32 animates pointOfView with a tween that its render loop never advances, so the
// overlay moves the camera itself.
export function interpolateView(from: CameraView, to: CameraView, k: number): CameraView {
  const t = Math.min(1, Math.max(0, k));
  const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const deltaLng = ((to.lng - from.lng + 540) % 360) - 180;
  const lng = ((from.lng + deltaLng * eased + 540) % 360) - 180;
  return {
    lat: from.lat + (to.lat - from.lat) * eased,
    lng,
    altitude: from.altitude + (to.altitude - from.altitude) * eased,
  };
}
