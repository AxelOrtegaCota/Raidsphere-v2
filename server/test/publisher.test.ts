import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@raidsphere/shared';
import { EventPublisher } from '../src/application/publisher.js';
import type { PublisherErrorKind, ServerEventDraft } from '../src/application/publisher.js';
import { ManualTime } from './support/fakes.js';

// All identifiers in this file are synthetic fixtures.
const votes = (channelId: string, totalVotes = 1): ServerEventDraft => ({
  type: 'roulette:votes', channelId, sessionId: 'session-a', payload: { votes: { en: 1 }, totalVotes },
});

const arrival: ServerEventDraft = {
  type: 'raid:arrived', channelId: 'rsdemo_en_01', sessionId: 'session-a',
  payload: {
    fromStreamerId: 'rsdemo_es_01', fromLogin: 'rsdemo_es_01', toStreamerId: 'rsdemo_en_01',
    viewers: 15, sourceLanguage: 'es', arrivedAtMs: 1000,
  },
};

function setup() {
  const time = new ManualTime(5000);
  const errors: PublisherErrorKind[] = [];
  const publisher = new EventPublisher({ clock: time, onError: (kind) => { errors.push(kind); } });
  return { time, errors, publisher };
}

describe('event publisher', () => {
  it('assigns version, unique event IDs, clock time, and per-channel sequences from 0', async () => {
    const { time, publisher } = setup();
    const first = publisher.publish(votes('rsdemo_es_01'));
    await time.advance(250);
    const second = publisher.publish(votes('rsdemo_es_01'));
    const other = publisher.publish(votes('rsdemo_fr_01'));
    expect([first?.sequence, second?.sequence, other?.sequence]).toEqual([0, 1, 0]);
    expect([first?.occurredAtMs, second?.occurredAtMs]).toEqual([5000, 5250]);
    expect(first?.version).toBe(1);
    expect(first?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set([first?.eventId, second?.eventId, other?.eventId]).size).toBe(3);
  });

  it('never delivers an invalid event, reports it without content, and keeps the sequence', () => {
    const { errors, publisher } = setup();
    const received: ServerEvent[] = [];
    publisher.subscribe('rsdemo_es_01', (event) => { received.push(event); });
    expect(publisher.publish(votes('rsdemo_es_01', 2))).toBeNull();
    expect(errors).toEqual(['invalid_event']);
    expect(received).toEqual([]);
    expect(publisher.publish(votes('rsdemo_es_01'))?.sequence).toBe(0);
  });

  it('delivers only to subscribers of the event channel', () => {
    const { publisher } = setup();
    const source: ServerEvent[] = [];
    const destination: ServerEvent[] = [];
    publisher.subscribe('rsdemo_es_01', (event) => { source.push(event); });
    publisher.subscribe('rsdemo_en_01', (event) => { destination.push(event); });
    publisher.publish(votes('rsdemo_es_01'));
    publisher.publish(arrival);
    expect(source.map((event) => event.type)).toEqual(['roulette:votes']);
    expect(destination.map((event) => event.type)).toEqual(['raid:arrived']);
  });

  it('stops delivery after unsubscribing, including during a delivery', () => {
    const { publisher } = setup();
    const calls: string[] = [];
    const unsubscribeSecond = publisher.subscribe('rsdemo_es_01', () => { calls.push('second'); });
    const unsubscribeFirst = publisher.subscribe('rsdemo_es_01', () => {
      calls.push('first');
      unsubscribeSecond();
    });
    publisher.publish(votes('rsdemo_es_01'));
    publisher.publish(votes('rsdemo_es_01'));
    unsubscribeFirst();
    publisher.publish(votes('rsdemo_es_01'));
    expect(calls).toEqual(['second', 'first', 'first']);
  });

  it('keeps delivering when one subscriber fails', () => {
    const { errors, publisher } = setup();
    let delivered = false;
    publisher.subscribe('rsdemo_es_01', () => { throw new Error('Synthetic subscriber failure.'); });
    publisher.subscribe('rsdemo_es_01', () => { delivered = true; });
    expect(publisher.publish(votes('rsdemo_es_01'))).not.toBeNull();
    expect(delivered).toBe(true);
    expect(errors).toEqual(['listener_failed']);
  });

  it('issues a validated event without broadcasting it, taking the next sequence', () => {
    const { publisher } = setup();
    const received: ServerEvent[] = [];
    publisher.subscribe('rsdemo_es_01', (event) => { received.push(event); });
    const snapshot = publisher.issue({
      type: 'state:snapshot', channelId: 'rsdemo_es_01', payload: { roulette: null, translationWindow: null },
    });
    expect(snapshot?.sequence).toBe(0);
    expect(received).toEqual([]);
    expect(publisher.publish(votes('rsdemo_es_01'))?.sequence).toBe(1);
  });
});
