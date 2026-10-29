import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, serverEventSchema } from '@raidsphere/shared';
import type { ServerEvent } from '@raidsphere/shared';
import type { Clock } from './ports.js';

// The single producer of server events (D2-10).

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// An event without the fields the publisher assigns.
export type ServerEventDraft = DistributiveOmit<ServerEvent, 'version' | 'eventId' | 'occurredAtMs' | 'sequence'>;
export type EventListener = (event: ServerEvent) => void;
// Reports carry no event content, so chat data never reaches logs.
export type PublisherErrorKind = 'invalid_event' | 'listener_failed';

export class EventPublisher {
  readonly #clock: Clock;
  readonly #onError: (kind: PublisherErrorKind) => void;
  readonly #nextSequence = new Map<string, number>();
  readonly #listeners = new Map<string, Set<{ listener: EventListener }>>();

  constructor(options: { clock: Clock; onError: (kind: PublisherErrorKind) => void }) {
    this.#clock = options.clock;
    this.#onError = options.onError;
  }

  // Validates and delivers to the event channel's subscribers, in subscription order.
  publish(draft: ServerEventDraft): ServerEvent | null {
    const event = this.#build(draft);
    if (!event) return null;
    for (const entry of [...(this.#listeners.get(event.channelId) ?? [])]) {
      try {
        entry.listener(event);
      } catch {
        this.#onError('listener_failed');
      }
    }
    return event;
  }

  // Validates and returns without broadcasting, e.g. a per-connection snapshot.
  // It still takes a sequence number so the client can order later events after it.
  issue(draft: ServerEventDraft): ServerEvent | null {
    return this.#build(draft);
  }

  subscribe(channelId: string, listener: EventListener): () => void {
    const entry = { listener };
    const listeners = this.#listeners.get(channelId) ?? new Set();
    listeners.add(entry);
    this.#listeners.set(channelId, listeners);
    return () => {
      listeners.delete(entry);
      if (listeners.size === 0 && this.#listeners.get(channelId) === listeners) this.#listeners.delete(channelId);
    };
  }

  // Sequences increase per channel within one server lifetime; invalid events take no number.
  #build(draft: ServerEventDraft): ServerEvent | null {
    const sequence = this.#nextSequence.get(draft.channelId) ?? 0;
    const result = serverEventSchema.safeParse({
      ...draft, version: PROTOCOL_VERSION, eventId: randomUUID(), occurredAtMs: this.#clock.now(), sequence,
    });
    if (!result.success) {
      this.#onError('invalid_event');
      return null;
    }
    this.#nextSequence.set(draft.channelId, sequence + 1);
    return result.data;
  }
}
