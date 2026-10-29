import { describe, expect, it } from 'vitest';
import { cryptoRandom, systemClock, timerScheduler } from '../src/application/runtime.js';
import { ManualTime, ScriptedRandom } from './support/fakes.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('manual test time', () => {
  it('runs due timers in time order, then creation order, and ends at the target time', async () => {
    const time = new ManualTime(0);
    const calls: string[] = [];
    time.schedule(20, () => calls.push(`b@${time.now()}`));
    time.schedule(10, () => calls.push(`a@${time.now()}`));
    time.schedule(20, () => calls.push(`c@${time.now()}`));
    time.schedule(31, () => calls.push('late'));
    await time.advance(30);
    expect(calls).toEqual(['a@10', 'b@20', 'c@20']);
    expect(time.now()).toBe(30);
    expect(time.pendingCount()).toBe(1);
  });

  it('skips cancelled timers', async () => {
    const time = new ManualTime(0);
    let ran = false;
    time.schedule(5, () => { ran = true; }).cancel();
    expect(time.pendingCount()).toBe(0);
    await time.advance(10);
    expect(ran).toBe(false);
  });

  it('runs timers scheduled during an advance when they fall due within it', async () => {
    const time = new ManualTime(0);
    const calls: number[] = [];
    time.schedule(10, () => {
      calls.push(time.now());
      time.schedule(5, () => calls.push(time.now()));
      time.schedule(50, () => calls.push(time.now()));
    });
    await time.advance(20);
    expect(calls).toEqual([10, 15]);
    expect(time.pendingCount()).toBe(1);
  });

  it('lets promise continuations settle before the next timer', async () => {
    const time = new ManualTime(0);
    const calls: string[] = [];
    time.schedule(1, () => { void Promise.resolve().then(() => calls.push('continuation')); });
    time.schedule(2, () => calls.push('second timer'));
    await time.advance(2);
    expect(calls).toEqual(['continuation', 'second timer']);
  });

  it('never moves backwards', async () => {
    await expect(new ManualTime(0).advance(-1)).rejects.toThrow();
  });
});

describe('scripted random source', () => {
  it('returns scripted values in order', () => {
    const random = new ScriptedRandom([2, 0]);
    expect(random.nextInt(3)).toBe(2);
    expect(random.nextInt(1)).toBe(0);
    expect(random.remaining).toBe(0);
  });

  it('fails when exhausted or out of range', () => {
    expect(() => new ScriptedRandom([]).nextInt(1)).toThrow();
    expect(() => new ScriptedRandom([3]).nextInt(3)).toThrow();
    expect(() => new ScriptedRandom([-1]).nextInt(3)).toThrow();
  });
});

describe('production runtime', () => {
  it('draws random integers within range', () => {
    for (let index = 0; index < 1000; index += 1) {
      const value = cryptoRandom.nextInt(7);
      expect(Number.isInteger(value) && value >= 0 && value < 7).toBe(true);
    }
  });

  it('runs scheduled callbacks unless cancelled', async () => {
    let ran = false;
    let cancelledRan = false;
    timerScheduler.schedule(0, () => { ran = true; });
    timerScheduler.schedule(0, () => { cancelledRan = true; }).cancel();
    await wait(20);
    expect(ran).toBe(true);
    expect(cancelledRan).toBe(false);
  });

  it('reports the current time in Unix milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(Number.isSafeInteger(now) && now >= before && now <= Date.now()).toBe(true);
  });
});
