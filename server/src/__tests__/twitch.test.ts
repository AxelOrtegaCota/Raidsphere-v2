/**
 * Tests for Module B: Twitch integration (simulated)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { candidateSchema, languageCodeSchema, raidLogSchema } from '@raidsphere/shared';
import {
  parseCommand,
  normalizeLanguage,
  hasControlPermission,
  type ChatMessage,
} from '../twitch/commands.js';
import {
  getSyntheticCandidates,
  getAvailableLanguages,
  selectRandomCandidate,
} from '../twitch/candidates.js';
import {
  SimulatedRaidGateway,
  getRaidGateway,
  setRaidGateway,
  type RaidRequest,
  type RaidResponse,
  type RaidArrivalEvent,
  type RaidOutcomeEvent,
  type RaidCancellationResult,
  type SimulationConfig,
} from '../twitch/raids.js';

describe('Command Parser', () => {
  const baseMessage: ChatMessage = {
    messageId: 'msg_001',
    userId: 'user_123',
    userLogin: 'testuser',
    channelId: 'channel_456',
    text: '',
    timestamp: Date.now(),
  };

  describe('parseCommand', () => {
    it('should parse !roulette command', () => {
      const result = parseCommand({ ...baseMessage, text: '!roulette' });
      expect(result).toEqual({
        type: 'roulette',
        userId: 'user_123',
        userLogin: 'testuser',
        channelId: 'channel_456',
      });
    });

    it('should parse !raidsphere alias', () => {
      const result = parseCommand({ ...baseMessage, text: '!raidsphere' });
      expect(result?.type).toBe('roulette');
    });

    it('should parse !spin alias', () => {
      const result = parseCommand({ ...baseMessage, text: '!spin' });
      expect(result?.type).toBe('roulette');
    });

    it('should parse !ruleta (Spanish alias)', () => {
      const result = parseCommand({ ...baseMessage, text: '!ruleta' });
      expect(result?.type).toBe('roulette');
    });

    it('should parse !vote with language code', () => {
      const result = parseCommand({ ...baseMessage, text: '!vote es' });
      expect(result).toEqual({
        type: 'vote',
        userId: 'user_123',
        userLogin: 'testuser',
        channelId: 'channel_456',
        language: 'es',
      });
    });

    it('should parse !vote with full language name', () => {
      const result = parseCommand({ ...baseMessage, text: '!vote spanish' });
      expect(result).toMatchObject({ type: 'vote', language: 'es' });
    });

    it('should parse !votar (Spanish alias)', () => {
      const result = parseCommand({ ...baseMessage, text: '!votar español' });
      expect(result).toMatchObject({ type: 'vote', language: 'es' });
    });

    it('should return error for !vote without language', () => {
      const result = parseCommand({ ...baseMessage, text: '!vote' });
      expect(result).toMatchObject({
        type: 'error',
        code: 'MISSING_ARGUMENT',
      });
    });

    it('should return error for !vote with invalid language', () => {
      const result = parseCommand({ ...baseMessage, text: '!vote xyz' });
      expect(result).toMatchObject({
        type: 'error',
        code: 'INVALID_LANGUAGE',
      });
    });

    it('should parse !cancel command', () => {
      const result = parseCommand({ ...baseMessage, text: '!cancel' });
      expect(result?.type).toBe('cancel');
    });

    it('should return null for non-commands', () => {
      expect(parseCommand({ ...baseMessage, text: 'hello everyone' })).toBeNull();
      expect(parseCommand({ ...baseMessage, text: 'roulette' })).toBeNull();
    });

    it('should be case-insensitive', () => {
      const result = parseCommand({ ...baseMessage, text: '!ROULETTE' });
      expect(result?.type).toBe('roulette');
    });
  });

  describe('normalizeLanguage', () => {
    it('should normalize language codes', () => {
      expect(normalizeLanguage('en')).toBe('en');
      expect(normalizeLanguage('ES')).toBe('es');
      expect(normalizeLanguage('pt')).toBe('pt');
    });

    it('should normalize full names', () => {
      expect(normalizeLanguage('english')).toBe('en');
      expect(normalizeLanguage('Spanish')).toBe('es');
      expect(normalizeLanguage('portuguese')).toBe('pt');
    });

    it('should normalize aliases', () => {
      expect(normalizeLanguage('br')).toBe('pt');
      expect(normalizeLanguage('jp')).toBe('ja');
      expect(normalizeLanguage('kr')).toBe('ko');
    });

    it('should return null for unknown', () => {
      expect(normalizeLanguage('xyz')).toBeNull();
    });
  });

  describe('hasControlPermission', () => {
    it('should allow broadcaster', () => {
      expect(hasControlPermission({ ...baseMessage, isBroadcaster: true })).toBe(true);
    });

    it('should allow moderator', () => {
      expect(hasControlPermission({ ...baseMessage, isModerator: true })).toBe(true);
    });

    it('should deny regular user', () => {
      expect(hasControlPermission(baseMessage)).toBe(false);
    });
  });
});

describe('Synthetic Candidates', () => {
  describe('getSyntheticCandidates', () => {
    it('should return candidates', () => {
      const candidates = getSyntheticCandidates();
      expect(candidates.length).toBeGreaterThan(0);
    });

    it('should filter by language', () => {
      const candidates = getSyntheticCandidates({ languages: ['es'] });
      expect(candidates.every(c => c.language === 'es')).toBe(true);
    });

    it('should filter by viewer range', () => {
      const candidates = getSyntheticCandidates({ minViewers: 30, maxViewers: 50 });
      expect(candidates.every(c => c.viewers >= 30 && c.viewers <= 50)).toBe(true);
    });

    it('should exclude specific streamer', () => {
      const candidates = getSyntheticCandidates({ excludeStreamerId: 'synth_001' });
      expect(candidates.find(c => c.streamerId === 'synth_001')).toBeUndefined();
    });

    it('should respect limit', () => {
      const candidates = getSyntheticCandidates({ limit: 5 });
      expect(candidates.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getAvailableLanguages', () => {
    it('should return unique languages', () => {
      const candidates = getSyntheticCandidates();
      const languages = getAvailableLanguages(candidates);
      expect(new Set(languages).size).toBe(languages.length);
    });
  });

  describe('selectRandomCandidate', () => {
    it('should return a candidate', () => {
      const candidates = getSyntheticCandidates();
      const selected = selectRandomCandidate(candidates);
      expect(selected).not.toBeNull();
      expect(candidates).toContain(selected);
    });

    it('should use injectable random', () => {
      const candidates = getSyntheticCandidates({ limit: 5 });
      const mockRandom = () => 0; // Always first
      const selected = selectRandomCandidate(candidates, mockRandom);
      expect(selected).toBe(candidates[0]);
    });

    it('should return null for empty array', () => {
      expect(selectRandomCandidate([])).toBeNull();
    });

    it('should select the only candidate across valid random boundaries', () => {
      const candidates = getSyntheticCandidates({ limit: 1 });
      expect(candidates).toHaveLength(1);

      for (const value of [0, 0.5, 1 - Number.EPSILON]) {
        expect(selectRandomCandidate(candidates, () => value)).toBe(candidates[0]);
      }
    });

    it('should select the last candidate when random is just below one', () => {
      const candidates = getSyntheticCandidates({ limit: 5 });
      expect(candidates).toHaveLength(5);

      const selected = selectRandomCandidate(candidates, () => 1 - Number.EPSILON);
      expect(selected).toBe(candidates[candidates.length - 1]);
    });
  });
});

describe('Simulated Raid Gateway', () => {
  let gateway: SimulatedRaidGateway;
  let gateways: SimulatedRaidGateway[];

  const testRequest: RaidRequest = {
    sessionId: 'fixture-session',
    fromStreamerId: 'from_001',
    fromLogin: 'fromuser',
    toStreamerId: 'to_001',
    toLogin: 'touser',
    sourceLanguage: 'en',
  };
  const unknownOperationId = '00000000-0000-4000-8000-000000000001';

  function createGateway(config: Partial<SimulationConfig> = {}, random: () => number = () => 0.5) {
    const instance = new SimulatedRaidGateway({
      acceptRate: 1, arrivalRate: 1, minCountdownMs: 50, maxCountdownMs: 100,
      observationTimeoutMs: 200, ...config,
    }, random);
    gateways.push(instance);
    return instance;
  }

  function sequence(...values: number[]): () => number {
    let index = 0;
    return () => {
      const value = values[index++];
      if (value === undefined) throw new Error('Fixture random sequence exhausted.');
      return value;
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    gateways = [];
    gateway = createGateway();
  });

  afterEach(() => {
    for (const instance of gateways) instance.dispose();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('startRaid', () => {
    it('should accept raid with 100% accept rate', async () => {
      const response = await gateway.startRaid(testRequest);
      expect(response.success).toBe(true);
      expect(response.outcome).toBe('accepted');
    });

    it('should reject raid with 0% accept rate, including a zero random draw', async () => {
      const rejectGateway = createGateway({ acceptRate: 0 }, () => 0);
      const response = await rejectGateway.startRaid(testRequest);
      expect(response.success).toBe(false);
      expect(response.outcome).toBe('rejected');
      expect(response).toMatchObject({ reason: 'target_not_accepting', estimatedCountdownSeconds: null });
      expect(rejectGateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should return estimated countdown', async () => {
      const response = await gateway.startRaid(testRequest);
      expect(response.estimatedCountdownSeconds).not.toBeNull();
      expect(response.estimatedCountdownSeconds).toBe(0);
    });

    it('assigns distinct UUIDs to same-millisecond accepted and rejected attempts', async () => {
      const first = await gateway.startRaid(testRequest);
      const overlapping = await gateway.startRaid({ ...testRequest, sessionId: 'fixture-second-session' });
      const independent = await gateway.startRaid({ ...testRequest, fromStreamerId: 'from_002' });
      const responses = [first, overlapping, independent];
      expect(new Set(responses.map(response => response.operationId)).size).toBe(3);
      for (const response of responses) {
        expect(response.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(response.requestedAtMs).toBe(1000);
        expect(response.operationId).not.toBe(response.sessionId);
      }
      expect(first.outcome).toBe('accepted');
      expect(overlapping).toMatchObject({ outcome: 'rejected', reason: 'source_busy' });
      expect(independent.outcome).toBe('accepted');
    });

    it('rejects duplicate and different-target overlap without replacing the active operation', async () => {
      const arrivals = vi.fn();
      const outcomes = vi.fn();
      gateway.onArrival(testRequest.toStreamerId, arrivals);
      gateway.onOutcome(testRequest.fromStreamerId, outcomes);
      const first = await gateway.startRaid(testRequest);
      const duplicate = await gateway.startRaid(testRequest);
      const otherTarget = await gateway.startRaid({ ...testRequest, toStreamerId: 'to_002', toLogin: 'otheruser' });
      for (const response of [duplicate, otherTarget]) {
        expect(response).toMatchObject({ success: false, outcome: 'rejected', reason: 'source_busy' });
        expect(outcomes).toHaveBeenCalledWith(expect.objectContaining({
          operationId: response.operationId, sessionId: testRequest.sessionId, outcome: 'rejected',
        }));
      }
      expect(gateway.getPendingCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(75);
      expect(arrivals).toHaveBeenCalledTimes(1);
      expect(arrivals).toHaveBeenCalledWith(expect.objectContaining({ operationId: first.operationId }));
      expect(outcomes).toHaveBeenCalledTimes(3);
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('allows independent source channels to raid the same destination', async () => {
      const arrivals = vi.fn();
      gateway.onArrival(testRequest.toStreamerId, arrivals);
      const first = await gateway.startRaid(testRequest);
      const second = await gateway.startRaid({
        ...testRequest, sessionId: 'other-session', fromStreamerId: 'from_002', fromLogin: 'otherfrom',
      });
      expect(gateway.getPendingCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(75);
      expect(arrivals).toHaveBeenCalledTimes(2);
      expect(arrivals).toHaveBeenCalledWith(expect.objectContaining({ operationId: first.operationId }));
      expect(arrivals).toHaveBeenCalledWith(expect.objectContaining({
        operationId: second.operationId, sessionId: 'other-session', fromStreamerId: 'from_002',
      }));
    });

    it('snapshots caller data before returning the request promise', async () => {
      const request = { ...testRequest };
      const arrivals = vi.fn();
      gateway.onArrival(testRequest.toStreamerId, arrivals);
      const pending = gateway.startRaid(request);
      Object.assign(request, {
        sessionId: 'mutated', fromStreamerId: 'mutated', toStreamerId: 'mutated',
        fromLogin: 'mutated', toLogin: 'mutated', sourceLanguage: 'es',
      });
      const response = await pending;
      expect(response).toMatchObject(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(arrivals).toHaveBeenCalledWith(expect.objectContaining({
        ...testRequest, operationId: response.operationId, requestedAtMs: response.requestedAtMs,
      }));
    });

    it('validates request fields before allocating state or timers', async () => {
      for (const invalid of [
        { ...testRequest, sessionId: '' }, { ...testRequest, sessionId: 's'.repeat(129) },
        { ...testRequest, fromStreamerId: '' }, { ...testRequest, toStreamerId: 't'.repeat(129) },
        { ...testRequest, fromLogin: 'invalid login' }, { ...testRequest, toLogin: 'x'.repeat(26) },
        { ...testRequest, sourceLanguage: 'unsupported' }, { ...testRequest, unexpected: true },
      ]) {
        // Deserialization models untrusted runtime input without weakening the public types.
        await expect(gateway.startRaid(JSON.parse(JSON.stringify(invalid)))).rejects.toThrow(TypeError);
      }
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts canonical identifier boundaries and non-UUID session identities', async () => {
      vi.setSystemTime(0);
      const response = await gateway.startRaid({
        ...testRequest, sessionId: 's'.repeat(128), fromStreamerId: 'f'.repeat(128),
        toStreamerId: 't'.repeat(128), fromLogin: 'f'.repeat(25), toLogin: 't'.repeat(25),
      });
      expect(response).toMatchObject({ outcome: 'accepted', requestedAtMs: 0, sessionId: 's'.repeat(128) });
    });
  });

  describe('cancelRaid', () => {
    it('should cancel the exact pending raid and preserve correlation', async () => {
      const outcomes = vi.fn();
      gateway.onOutcome(testRequest.fromStreamerId, outcomes);
      const response = await gateway.startRaid(testRequest);
      const cancelled = await gateway.cancelRaid({
        operationId: response.operationId, fromStreamerId: testRequest.fromStreamerId,
      });
      expect(cancelled).toMatchObject({
        status: 'cancelled', operationId: response.operationId, sessionId: testRequest.sessionId,
        fromStreamerId: testRequest.fromStreamerId, toStreamerId: testRequest.toStreamerId,
        requestedAtMs: 1000, completedAtMs: 1000,
      });
      expect(outcomes).toHaveBeenCalledTimes(1);
      expect(outcomes).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled', operationId: response.operationId }));
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should return not_active for a non-existent raid', async () => {
      expect(await gateway.cancelRaid({ operationId: unknownOperationId, fromStreamerId: 'nobody' }))
        .toEqual({ status: 'not_active', operationId: unknownOperationId, fromStreamerId: 'nobody' });
    });

    it('rejects invalid cancellation input without changing pending state', async () => {
      await gateway.startRaid(testRequest);
      await expect(gateway.cancelRaid({ operationId: 'not-a-uuid', fromStreamerId: 'from_001' }))
        .rejects.toThrow(TypeError);
      expect(gateway.getPendingCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(2);
    });

    it('does not cancel another source and does not complete twice', async () => {
      const outcomes = vi.fn();
      gateway.onOutcome(testRequest.fromStreamerId, outcomes);
      const response = await gateway.startRaid(testRequest);
      expect(await gateway.cancelRaid({ operationId: response.operationId, fromStreamerId: 'other-source' }))
        .toMatchObject({ status: 'not_active' });
      expect(gateway.getPendingCount()).toBe(1);
      expect(outcomes).not.toHaveBeenCalled();
      const cancellation = { operationId: response.operationId, fromStreamerId: testRequest.fromStreamerId };
      await gateway.cancelRaid(cancellation);
      expect(await gateway.cancelRaid(cancellation)).toMatchObject({ status: 'not_active' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(outcomes).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation before a cancellation listener starts another operation', async () => {
      let replacement: Promise<RaidResponse> | undefined;
      gateway.onOutcome(testRequest.fromStreamerId, event => {
        if (event.outcome === 'cancelled') replacement = gateway.startRaid(testRequest);
      });
      const first = await gateway.startRaid(testRequest);
      await gateway.cancelRaid({ operationId: first.operationId, fromStreamerId: testRequest.fromStreamerId });
      if (!replacement) throw new Error('Expected a reentrant replacement request.');
      expect(await replacement).toMatchObject({ outcome: 'accepted' });
      expect(gateway.getPendingCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(2);
    });
  });

  describe('arrival and terminal outcomes', () => {
    it('should fire a correlated arrival callback and validate an explicit canonical log projection', async () => {
      const arrivals: RaidArrivalEvent[] = [];
      const outcomes: RaidOutcomeEvent[] = [];
      gateway.onArrival('to_001', event => { arrivals.push(event); });
      gateway.onOutcome('from_001', event => { outcomes.push(event); });
      const response = await gateway.startRaid(testRequest);
      expect(response.outcome).toBe('accepted');
      expect(arrivals).toHaveLength(0);
      expect(outcomes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(75);
      expect(arrivals).toHaveLength(1);
      expect(outcomes).toHaveLength(1);
      const arrival = arrivals[0];
      if (!arrival) throw new Error('Expected an observed arrival.');
      expect(arrival.fromStreamerId).toBe('from_001');
      expect(arrival.toStreamerId).toBe('to_001');
      expect(arrival).toMatchObject({
        operationId: response.operationId, sessionId: testRequest.sessionId, requestedAtMs: 1000, arrivedAtMs: 1075,
      });
      expect(outcomes[0]).toMatchObject({ outcome: 'arrived', completedAtMs: 1075, arrival });
      const log = {
        sessionId: arrival.sessionId, fromStreamerId: arrival.fromStreamerId,
        toStreamerId: arrival.toStreamerId, viewers: arrival.viewers, arrivedAtMs: arrival.arrivedAtMs,
      };
      expect(raidLogSchema.parse(log)).toEqual(log);
      expect(raidLogSchema.safeParse(arrival).success).toBe(false);
      expect(raidLogSchema.safeParse({ ...log, operationId: arrival.operationId }).success).toBe(false);
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(outcomes).toHaveLength(1);
      expect(await gateway.cancelRaid({
        operationId: response.operationId, fromStreamerId: testRequest.fromStreamerId,
      })).toMatchObject({ status: 'not_active' });
    });

    it('should not fire an arrival if cancelled', async () => {
      const arrivals = vi.fn();
      gateway.onArrival('to_001', arrivals);
      const response = await gateway.startRaid(testRequest);
      await gateway.cancelRaid({ operationId: response.operationId, fromStreamerId: 'from_001' });
      await vi.advanceTimersByTimeAsync(200);
      expect(arrivals).not.toHaveBeenCalled();
    });

    it('keeps a missing arrival pending until an explicit timeout', async () => {
      const instance = createGateway({ arrivalRate: 0 }, () => 0);
      const outcomes = vi.fn();
      const arrivals = vi.fn();
      instance.onOutcome('from_001', outcomes);
      instance.onArrival('to_001', arrivals);
      const response = await instance.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(50);
      expect(instance.getPendingCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      expect(outcomes).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(outcomes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        ...testRequest, operationId: response.operationId, outcome: 'timed_out', reason: 'observation_timeout',
      }));
      expect(arrivals).not.toHaveBeenCalled();
      expect(instance.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('uses the 15000ms default observation timeout', async () => {
      const instance = new SimulatedRaidGateway({
        acceptRate: 1, arrivalRate: 0, minCountdownMs: 0, maxCountdownMs: 0,
      }, () => 0);
      gateways.push(instance);
      const outcomes = vi.fn();
      instance.onOutcome('from_001', outcomes);
      await instance.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(14999);
      expect(outcomes).not.toHaveBeenCalled();
      expect(instance.getPendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'timed_out', completedAtMs: 16000 }));
    });

    it('ignores stale arrival and deadline callbacks after a same-source replacement', async () => {
      const scheduled = vi.spyOn(globalThis, 'setTimeout');
      const arrivals = vi.fn();
      const outcomes = vi.fn();
      gateway.onArrival('to_001', arrivals);
      gateway.onOutcome('from_001', outcomes);
      const first = await gateway.startRaid(testRequest);
      const staleArrival = scheduled.mock.calls[0]?.[0];
      const staleDeadline = scheduled.mock.calls[1]?.[0];
      if (typeof staleArrival !== 'function' || typeof staleDeadline !== 'function') {
        throw new Error('Expected both scheduled callbacks.');
      }
      await gateway.cancelRaid({ operationId: first.operationId, fromStreamerId: 'from_001' });
      const second = await gateway.startRaid(testRequest);
      staleArrival();
      staleDeadline();
      expect(gateway.getPendingCount()).toBe(1);
      expect(outcomes).toHaveBeenCalledTimes(1);
      expect(arrivals).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(75);
      expect(arrivals).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: second.operationId }));
      expect(outcomes).toHaveBeenCalledTimes(2);
    });

    it('does not cancel or duplicate an arrival that wins the timer-order race', async () => {
      const outcomes = vi.fn();
      gateway.onOutcome('from_001', outcomes);
      const response = await gateway.startRaid(testRequest);
      const cancellation = new Promise<RaidCancellationResult>((resolve, reject) => {
        setTimeout(() => {
          gateway.cancelRaid({ operationId: response.operationId, fromStreamerId: 'from_001' }).then(resolve, reject);
        }, 75);
      });
      await vi.advanceTimersByTimeAsync(75);
      expect(await cancellation).toMatchObject({ status: 'not_active' });
      expect(outcomes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'arrived' }));
    });
  });

  describe('subscriptions', () => {
    it('keeps duplicate callback registrations independent and unsubscription idempotent', async () => {
      const callback = vi.fn();
      const unsubscribeFirst = gateway.onArrival('to_001', callback);
      gateway.onArrival('to_001', callback);
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(callback).toHaveBeenCalledTimes(2);
      unsubscribeFirst();
      unsubscribeFirst();
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('does not let an old unsubscribe remove a newly created registration set', async () => {
      const oldCallback = vi.fn();
      const callback = vi.fn();
      const unsubscribeOld = gateway.onArrival('to_001', oldCallback);
      unsubscribeOld();
      gateway.onArrival('to_001', callback);
      unsubscribeOld();
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(oldCallback).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('supports independent outcome listeners and source/destination scoping', async () => {
      const callback = vi.fn();
      const otherSource = vi.fn();
      const otherDestination = vi.fn();
      const unsubscribe = gateway.onOutcome('from_001', callback);
      gateway.onOutcome('from_001', callback);
      gateway.onOutcome('other-source', otherSource);
      gateway.onArrival('other-destination', otherDestination);
      unsubscribe();
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(otherSource).not.toHaveBeenCalled();
      expect(otherDestination).not.toHaveBeenCalled();
    });

    it('respects unsubscription during delivery', async () => {
      let unsubscribeSecond = () => {};
      const second = vi.fn();
      gateway.onOutcome('from_001', () => { unsubscribeSecond(); });
      unsubscribeSecond = gateway.onOutcome('from_001', second);
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(second).not.toHaveBeenCalled();
    });

    it('contains throwing and rejecting listeners while delivering to unaffected listeners', async () => {
      const observed = vi.fn();
      const arrived = vi.fn();
      const throwing = () => { throw new Error('Synthetic observer failure.'); };
      const rejecting = async () => { throw new Error('Synthetic asynchronous observer failure.'); };
      gateway.onOutcome('from_001', throwing);
      gateway.onOutcome('from_001', rejecting);
      gateway.onOutcome('from_001', observed);
      gateway.onArrival('to_001', throwing);
      gateway.onArrival('to_001', rejecting);
      gateway.onArrival('to_001', arrived);
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(200);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(arrived).toHaveBeenCalledTimes(1);
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('isolates payload mutations, including nested arrival data', async () => {
      const observed = vi.fn();
      const arrived = vi.fn();
      gateway.onOutcome('from_001', event => {
        Object.assign(event, { sessionId: 'mutated' });
        if (event.outcome === 'arrived') Object.assign(event.arrival, { viewers: 999, toStreamerId: 'mutated' });
      });
      gateway.onOutcome('from_001', observed);
      gateway.onArrival('to_001', event => { Object.assign(event, { fromStreamerId: 'mutated' }); });
      gateway.onArrival('to_001', arrived);
      const response = await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: testRequest.sessionId, operationId: response.operationId,
        arrival: expect.objectContaining({ viewers: 28, toStreamerId: 'to_001' }),
      }));
      expect(arrived).toHaveBeenCalledWith(expect.objectContaining({ fromStreamerId: 'from_001', viewers: 28 }));
    });

    it('contains a listener rejection that settles after disposal', async () => {
      let release = () => {};
      const finished = vi.fn();
      gateway.onOutcome('from_001', async () => {
        await new Promise<void>(resolve => { release = resolve; });
        finished();
        throw new Error('Synthetic late observer failure.');
      });
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      gateway.dispose();
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(finished).toHaveBeenCalledTimes(1);
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('validates subscription channel identifiers', () => {
      expect(() => gateway.onArrival('', () => {})).toThrow(TypeError);
      expect(() => gateway.onOutcome('x'.repeat(129), () => {})).toThrow(TypeError);
    });
  });

  describe('cleanup and ownership', () => {
    it('finalizes the entire pending set before clearPending notifies listeners', async () => {
      const pendingCounts: number[] = [];
      const events: RaidOutcomeEvent[] = [];
      const listener = (event: RaidOutcomeEvent) => {
        pendingCounts.push(gateway.getPendingCount());
        events.push(event);
      };
      gateway.onOutcome('from_001', listener);
      gateway.onOutcome('from_002', listener);
      const first = await gateway.startRaid(testRequest);
      const second = await gateway.startRaid({ ...testRequest, fromStreamerId: 'from_002' });
      const cleared = gateway.clearPending();
      expect(cleared).toHaveLength(2);
      expect(events).toEqual(cleared);
      expect(pendingCounts).toEqual([0, 0]);
      expect(cleared.map(event => event.operationId)).toEqual([first.operationId, second.operationId]);
      expect(cleared.every(event => event.outcome === 'unknown' && event.reason === 'cleared')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(gateway.clearPending()).toEqual([]);
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(events).toHaveLength(3);
      expect(events[2]?.outcome).toBe('arrived');
    });

    it('disposes pending operations without delivery and rejects subsequent starts and subscriptions', async () => {
      const outcomes = vi.fn();
      const arrivals = vi.fn();
      gateway.onOutcome('from_001', outcomes);
      gateway.onArrival('to_001', arrivals);
      const response = await gateway.startRaid(testRequest);
      expect(gateway.dispose()).toEqual([
        expect.objectContaining({
          operationId: response.operationId, sessionId: testRequest.sessionId,
          outcome: 'unknown', reason: 'gateway_disposed',
        }),
      ]);
      expect(gateway.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(gateway.dispose()).toEqual([]);
      expect(gateway.clearPending()).toEqual([]);
      await expect(gateway.startRaid(testRequest)).rejects.toThrow('disposed');
      expect(() => gateway.onArrival('to_001', arrivals)).toThrow('disposed');
      expect(() => gateway.onOutcome('from_001', outcomes)).toThrow('disposed');
      expect(await gateway.cancelRaid({ operationId: response.operationId, fromStreamerId: 'from_001' }))
        .toMatchObject({ status: 'not_active' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(outcomes).not.toHaveBeenCalled();
      expect(arrivals).not.toHaveBeenCalled();
    });

    it('stops remaining delivery when an outcome listener disposes the gateway', async () => {
      const laterOutcome = vi.fn();
      const arrival = vi.fn();
      gateway.onOutcome('from_001', () => { gateway.dispose(); });
      gateway.onOutcome('from_001', laterOutcome);
      gateway.onArrival('to_001', arrival);
      await gateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(75);
      expect(laterOutcome).not.toHaveBeenCalled();
      expect(arrival).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not automatically dispose an externally owned default gateway during replacement', async () => {
      const previous = getRaidGateway();
      const replacement = createGateway();
      try {
        setRaidGateway(gateway);
        await gateway.startRaid(testRequest);
        setRaidGateway(replacement);
        expect(getRaidGateway()).toBe(replacement);
        expect(gateway.getPendingCount()).toBe(1);
        expect((await gateway.startRaid({ ...testRequest, fromStreamerId: 'from_002' })).outcome).toBe('accepted');
      } finally {
        setRaidGateway(previous);
      }
    });
  });

  describe('reentrant startup interruption', () => {
    it.each([1, 2])('rejects startup when random draw %s disposes the gateway', async interruptAt => {
      let draws = 0;
      let disposedOutcomes: readonly RaidOutcomeEvent[] = [];
      const instance: SimulatedRaidGateway = createGateway({}, () => {
        draws++;
        if (draws === interruptAt) disposedOutcomes = instance.dispose();
        return 0.5;
      });
      const observed = vi.fn();
      const arrivals = vi.fn();
      instance.onOutcome('from_001', observed);
      instance.onArrival('to_001', arrivals);

      await expect(instance.startRaid(testRequest))
        .rejects.toThrow('Raid operation was interrupted during startup.');
      expect(draws).toBe(interruptAt);
      expect(disposedOutcomes).toHaveLength(1);
      expect(disposedOutcomes[0]).toMatchObject({
        ...testRequest, outcome: 'unknown', reason: 'gateway_disposed',
        requestedAtMs: 1000, completedAtMs: 1000,
      });
      expect(disposedOutcomes[0]?.operationId).toEqual(expect.any(String));
      expect(instance.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(instance.dispose()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(observed).not.toHaveBeenCalled();
      expect(arrivals).not.toHaveBeenCalled();
    });

    it.each([1, 2])('rejects startup when random draw %s clears pending operations', async interruptAt => {
      let draws = 0;
      let clearedOutcomes: readonly RaidOutcomeEvent[] = [];
      const instance: SimulatedRaidGateway = createGateway({}, () => {
        draws++;
        if (draws === interruptAt) clearedOutcomes = instance.clearPending();
        return 0.5;
      });
      const observed: RaidOutcomeEvent[] = [];
      const arrivals = vi.fn();
      instance.onOutcome('from_001', event => { observed.push(event); });
      instance.onArrival('to_001', arrivals);

      await expect(instance.startRaid(testRequest))
        .rejects.toThrow('Raid operation was interrupted during startup.');
      expect(draws).toBe(interruptAt);
      expect(clearedOutcomes).toHaveLength(1);
      expect(observed).toEqual(clearedOutcomes);
      const interrupted = clearedOutcomes[0];
      if (!interrupted) throw new Error('Expected an interrupted operation outcome.');
      expect(interrupted).toMatchObject({
        ...testRequest, outcome: 'unknown', reason: 'cleared', requestedAtMs: 1000, completedAtMs: 1000,
      });
      expect(instance.getPendingCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(observed).toHaveLength(1);
      expect(arrivals).not.toHaveBeenCalled();

      const next = await instance.startRaid(testRequest);
      expect(next.outcome).toBe('accepted');
      expect(next.operationId).not.toBe(interrupted.operationId);
      await vi.advanceTimersByTimeAsync(75);
      expect(observed).toHaveLength(2);
      expect(observed[1]).toMatchObject({ operationId: next.operationId, outcome: 'arrived' });
      expect(arrivals).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: next.operationId }));
    });

    it('preserves a same-source replacement started by a cleanup observer', async () => {
      let interrupted = false;
      let replacement: Promise<RaidResponse> | undefined;
      const instance: SimulatedRaidGateway = createGateway({}, () => {
        if (!interrupted) {
          interrupted = true;
          instance.clearPending();
        }
        return 0.5;
      });
      const observed: RaidOutcomeEvent[] = [];
      const arrivals = vi.fn();
      instance.onOutcome('from_001', event => {
        observed.push(event);
        if (event.outcome === 'unknown' && event.reason === 'cleared') {
          replacement = instance.startRaid({ ...testRequest, sessionId: 'replacement-session' });
        }
      });
      instance.onArrival('to_001', arrivals);

      await expect(instance.startRaid(testRequest))
        .rejects.toThrow('Raid operation was interrupted during startup.');
      if (!replacement) throw new Error('Expected a reentrant replacement.');
      const accepted = await replacement;
      expect(accepted).toMatchObject({ outcome: 'accepted', sessionId: 'replacement-session' });
      expect(observed).toHaveLength(1);
      expect(accepted.operationId).not.toBe(observed[0]?.operationId);
      expect(instance.getPendingCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(75);
      expect(observed).toHaveLength(2);
      expect(observed[1]).toMatchObject({ operationId: accepted.operationId, outcome: 'arrived' });
      expect(arrivals).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        operationId: accepted.operationId, sessionId: 'replacement-session',
      }));
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])('preserves interruption when the random callback also fails; dispose=%s', async shouldDispose => {
      for (const throws of [false, true]) {
        let terminal: readonly RaidOutcomeEvent[] = [];
        const instance: SimulatedRaidGateway = createGateway({}, () => {
          terminal = shouldDispose ? instance.dispose() : instance.clearPending();
          if (throws) throw new Error('Synthetic private callback detail.');
          return Number.NaN;
        });
        const observed = vi.fn();
        instance.onOutcome('from_001', observed);
        await expect(instance.startRaid(testRequest))
          .rejects.toThrow('Raid operation was interrupted during startup.');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          outcome: 'unknown', reason: shouldDispose ? 'gateway_disposed' : 'cleared',
        });
        expect(JSON.stringify(terminal)).not.toContain('Synthetic private callback detail.');
        expect(observed).toHaveBeenCalledTimes(shouldDispose ? 0 : 1);
        expect(instance.getPendingCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      }
    });
  });

  describe('simulation boundaries', () => {
    it.each([0, 0.5, 1 - Number.EPSILON])('accepts and observes arrival at probability one with draw %s', async draw => {
      const instance = createGateway({}, () => draw);
      const arrival = vi.fn();
      instance.onArrival('to_001', arrival);
      expect((await instance.startRaid(testRequest)).outcome).toBe('accepted');
      await vi.advanceTimersByTimeAsync(100);
      expect(arrival).toHaveBeenCalledTimes(1);
    });

    it('uses strict probability thresholds for both acceptance and arrival', async () => {
      const rejectGateway = createGateway({ acceptRate: 0.5 }, () => 0.5);
      expect((await rejectGateway.startRaid(testRequest)).outcome).toBe('rejected');
      const missingGateway = createGateway({ arrivalRate: 0.5 }, sequence(0, 0, 0.5));
      const outcomes = vi.fn();
      missingGateway.onOutcome('from_001', outcomes);
      await missingGateway.startRaid(testRequest);
      await vi.advanceTimersByTimeAsync(200);
      expect(outcomes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'timed_out' }));
    });

    it.each([
      { acceptRate: -0.1 }, { acceptRate: 1.1 }, { arrivalRate: Number.NaN },
      { arrivalRate: Number.POSITIVE_INFINITY }, { arrivalRate: -1 }, { arrivalRate: 2 },
      { minCountdownMs: -1 }, { maxCountdownMs: 0.5 }, { minCountdownMs: 101, maxCountdownMs: 100 },
      { observationTimeoutMs: 100 }, { observationTimeoutMs: 0 }, { observationTimeoutMs: 0.5 },
      { observationTimeoutMs: 2_147_483_648 }, { maxCountdownMs: 2_147_483_648 },
      { minViewers: -1 }, { maxViewers: 0.5 }, { minViewers: 51, maxViewers: 50 },
      { maxViewers: Number.MAX_SAFE_INTEGER + 1 }, { maxViewers: Number.POSITIVE_INFINITY },
    ])('rejects invalid simulation configuration %j', config => {
      expect(() => createGateway(config)).toThrow(TypeError);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('snapshots simulation configuration and accepts zero viewer/countdown bounds', async () => {
      const config = { acceptRate: 1, minViewers: 0, maxViewers: 0, minCountdownMs: 0, maxCountdownMs: 0 };
      const instance = createGateway(config, () => 0);
      config.acceptRate = 0;
      const arrival = vi.fn();
      instance.onArrival('to_001', arrival);
      expect((await instance.startRaid(testRequest)).outcome).toBe('accepted');
      await vi.advanceTimersByTimeAsync(1);
      expect(arrival).toHaveBeenCalledWith(expect.objectContaining({ viewers: 0 }));
    });

    it.each([-1, 1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'contains invalid draw %s before and after acceptance', async invalid => {
        for (const draws of [[invalid], [0, invalid]]) {
          const instance = createGateway({}, sequence(...draws));
          const outcomes = vi.fn();
          instance.onOutcome('from_001', outcomes);
          expect(await instance.startRaid(testRequest)).toMatchObject({
            outcome: 'rejected', reason: 'simulation_error', success: false,
          });
          expect(outcomes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'rejected' }));
          expect(instance.getPendingCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        }
        for (const draws of [[0, 0, invalid], [0, 0, 0, invalid]]) {
          const instance = createGateway({}, sequence(...draws));
          const outcomes = vi.fn();
          const arrivals = vi.fn();
          instance.onOutcome('from_001', outcomes);
          instance.onArrival('to_001', arrivals);
          expect((await instance.startRaid(testRequest)).outcome).toBe('accepted');
          await vi.advanceTimersByTimeAsync(50);
          expect(outcomes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            outcome: 'unknown', reason: 'simulation_error',
          }));
          expect(arrivals).not.toHaveBeenCalled();
          expect(instance.getPendingCount()).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        }
      }
    );

    it('contains thrown simulation errors without exposing their messages', async () => {
      const instance = createGateway({}, () => { throw new Error('Synthetic private detail.'); });
      const response = await instance.startRaid(testRequest);
      expect(response).toMatchObject({ outcome: 'rejected', reason: 'simulation_error' });
      expect(JSON.stringify(response)).not.toContain('Synthetic private detail.');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('Batch 2 command validation', () => {
  const message: ChatMessage = {
    messageId: 'fixture-message', userId: 'fixture-user', userLogin: 'fixture_user',
    channelId: 'fixture-channel', text: '!roulette', timestamp: 1000,
  };

  it.each(['constructor', '__proto__', 'prototype', 'toString', '', 'unsupported'])(
    'rejects invalid alias %s', alias => {
      expect(normalizeLanguage(alias)).toBeNull();
      expect(parseCommand({ ...message, text: '!vote ' + alias })?.type).toBe('error');
    }
  );

  it.each(['pt', ' PORTUGUESE ', 'português', 'PORTUGUÊS', 'portugués', 'br'])(
    'preserves valid Portuguese alias %s', alias => {
      expect(normalizeLanguage(alias)).toBe('pt');
    }
  );

  it('accepts only canonical normalized languages', () => {
    for (const alias of ['English', 'español', 'français', 'deutsch', 'japanese', 'coreano']) {
      expect(languageCodeSchema.safeParse(normalizeLanguage(alias)).success).toBe(true);
    }
  });

  it('rejects invalid chat input before parsing a control command', () => {
    for (const invalid of [
      { ...message, channelId: '' },
      { ...message, userLogin: 'invalid login' },
      { ...message, timestamp: -1 },
      { ...message, timestamp: Number.NaN },
      { ...message, timestamp: Number.MAX_SAFE_INTEGER + 1 },
      { ...message, text: '!roulette' + ' '.repeat(501) },
    ]) {
      expect(parseCommand(invalid)).toEqual({
        type: 'error', code: 'INVALID_COMMAND', message: 'Invalid chat message.', originalText: '',
      });
    }
  });
});

describe('Batch 2 synthetic candidate boundaries', () => {
  it('distinguishes omitted and explicitly empty allowed languages', () => {
    expect(getSyntheticCandidates({}, () => 0.5).length).toBeGreaterThan(0);
    expect(getSyntheticCandidates({ languages: [] }, () => 0.5)).toEqual([]);
  });

  it('allows zero limit and inclusive viewer boundaries', () => {
    expect(getSyntheticCandidates({ limit: 0 })).toEqual([]);
    const candidates = getSyntheticCandidates({ minViewers: 25, maxViewers: 25 }, () => 0.5);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(candidate => candidate.viewers === 25)).toBe(true);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 101])(
    'rejects invalid candidate limit %s', limit => {
      expect(() => getSyntheticCandidates({ limit })).toThrow(TypeError);
    }
  );

  it.each([
    { minViewers: -1 }, { maxViewers: -1 }, { minViewers: 0.5 },
    { maxViewers: Number.NaN }, { minViewers: Number.POSITIVE_INFINITY },
    { minViewers: 50, maxViewers: 10 },
    { maxViewers: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid viewer boundaries %j', filters => {
    expect(() => getSyntheticCandidates(filters)).toThrow(TypeError);
  });

  it('uses controlled randomness for generation, games, and shuffling', () => {
    const first = getSyntheticCandidates({ limit: 5 }, () => 0.25);
    const second = getSyntheticCandidates({ limit: 5 }, () => 0.25);
    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
    expect(selectRandomCandidate(first, () => 0)).toEqual(first[0]);
    expect(selectRandomCandidate(first, () => 1 - Number.EPSILON)).toEqual(first[4]);
  });

  it.each([-0.1, 1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid random value %s', value => {
      expect(() => getSyntheticCandidates({}, () => value)).toThrow(RangeError);
      const candidates = getSyntheticCandidates({ limit: 1 }, () => 0);
      expect(() => selectRandomCandidate(candidates, () => value)).toThrow(RangeError);
    }
  );

  it('preserves self-exclusion and emits valid offline candidates', () => {
    const candidates = getSyntheticCandidates({ excludeStreamerId: 'synth_001' }, () => 0.5);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.streamerId).not.toBe('synth_001');
      expect(candidate.avatarUrl).toBeNull();
      expect(candidateSchema.parse(candidate)).toEqual(candidate);
    }
  });
});
