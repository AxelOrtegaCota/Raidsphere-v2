import { randomInt } from 'node:crypto';
import type { Clock, RandomSource, Scheduler } from './ports.js';

// Production implementations of the injected runtime ports (D2-09).

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const timerScheduler: Scheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

export const cryptoRandom: RandomSource = {
  nextInt: (maxExclusive) => randomInt(maxExclusive),
};
