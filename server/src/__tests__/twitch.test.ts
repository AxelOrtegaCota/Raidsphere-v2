/**
 * Tests for Module B: Twitch integration (simulated)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCommand,
  normalizeLanguage,
  hasControlPermission,
  ChatMessage,
} from '../twitch/commands.js';
import {
  getSyntheticCandidates,
  getAvailableLanguages,
  selectRandomCandidate,
} from '../twitch/candidates.js';
import {
  SimulatedRaidGateway,
  RaidRequest,
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
  });
});

describe('Simulated Raid Gateway', () => {
  let gateway: SimulatedRaidGateway;
  
  beforeEach(() => {
    // Use fixed random for predictable tests
    gateway = new SimulatedRaidGateway(
      { acceptRate: 1, arrivalRate: 1, minCountdownMs: 50, maxCountdownMs: 100 },
      () => 0.5
    );
  });
  
  const testRequest: RaidRequest = {
    fromStreamerId: 'from_001',
    fromLogin: 'fromuser',
    toStreamerId: 'to_001',
    toLogin: 'touser',
    sourceLanguage: 'en',
  };
  
  describe('startRaid', () => {
    it('should accept raid with 100% accept rate', async () => {
      const response = await gateway.startRaid(testRequest);
      expect(response.success).toBe(true);
      expect(response.outcome).toBe('accepted');
    });
    
    it('should reject raid with 0% accept rate', async () => {
      const rejectGateway = new SimulatedRaidGateway({ acceptRate: 0 });
      const response = await rejectGateway.startRaid(testRequest);
      expect(response.success).toBe(false);
      expect(response.outcome).toBe('rejected');
    });
    
    it('should return estimated countdown', async () => {
      const response = await gateway.startRaid(testRequest);
      // With fixed random at 0.5, countdown is minCountdownMs + 0.5 * (maxCountdownMs - minCountdownMs)
      // = 50 + 0.5 * 50 = 75ms → 0 seconds when rounded (75/1000 = 0.075)
      // So we just check it's not null for accepted raids
      expect(response.estimatedCountdownSeconds).not.toBeNull();
    });
  });
  
  describe('cancelRaid', () => {
    it('should cancel pending raid', async () => {
      await gateway.startRaid(testRequest);
      const cancelled = await gateway.cancelRaid('from_001', 'to_001');
      expect(cancelled).toBe(true);
    });
    
    it('should return false for non-existent raid', async () => {
      const cancelled = await gateway.cancelRaid('nobody', 'nobody');
      expect(cancelled).toBe(false);
    });
  });
  
  describe('onArrival', () => {
    it('should fire arrival callback', async () => {
      let arrived = false;
      gateway.onArrival('to_001', (event) => {
        arrived = true;
        expect(event.fromStreamerId).toBe('from_001');
        expect(event.toStreamerId).toBe('to_001');
      });
      
      await gateway.startRaid(testRequest);
      
      // Wait for arrival
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(arrived).toBe(true);
    });
    
    it('should not fire if cancelled', async () => {
      let arrived = false;
      gateway.onArrival('to_001', () => { arrived = true; });
      
      await gateway.startRaid(testRequest);
      await gateway.cancelRaid('from_001', 'to_001');
      
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(arrived).toBe(false);
    });
  });
});
