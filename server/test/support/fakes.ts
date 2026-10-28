import type { Clock, RandomSource, Scheduler, TimerHandle } from '../../src/application/ports.js';

interface PendingTimer {
  dueAtMs: number;
  order: number;
  callback: () => void;
  cancelled: boolean;
}

// Lets queued promise continuations run between timers.
const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Deterministic clock and scheduler. Time moves only through advance().
export class ManualTime implements Clock, Scheduler {
  #nowMs: number;
  #nextOrder = 0;
  #timers: PendingTimer[] = [];

  constructor(startMs = 1_000_000) {
    this.#nowMs = startMs;
  }

  now(): number {
    return this.#nowMs;
  }

  schedule(delayMs: number, callback: () => void): TimerHandle {
    const timer: PendingTimer = {
      dueAtMs: this.#nowMs + Math.max(0, delayMs), order: this.#nextOrder++, callback, cancelled: false,
    };
    this.#timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  pendingCount(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  // Runs due timers in time order (creation order on ties), including timers created meanwhile.
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Time can only move forward.');
    const targetMs = this.#nowMs + ms;
    for (;;) {
      this.#timers = this.#timers.filter((timer) => !timer.cancelled);
      const next = this.#timers
        .filter((timer) => timer.dueAtMs <= targetMs)
        .sort((a, b) => a.dueAtMs - b.dueAtMs || a.order - b.order)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#nowMs = next.dueAtMs;
      next.callback();
      await flushPromises();
    }
    this.#nowMs = targetMs;
  }
}

// Returns scripted values in order and fails loudly when exhausted or out of range.
export class ScriptedRandom implements RandomSource {
  readonly #values: number[];

  constructor(values: readonly number[]) {
    this.#values = [...values];
  }

  get remaining(): number {
    return this.#values.length;
  }

  nextInt(maxExclusive: number): number {
    const value = this.#values.shift();
    if (value === undefined) throw new Error('The scripted random source is exhausted.');
    if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
      throw new Error(`Scripted value ${value} is outside [0, ${maxExclusive}).`);
    }
    return value;
  }
}
