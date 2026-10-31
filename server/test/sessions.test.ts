import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth session store', () => {
  it('does not keep the process alive with its cleanup timer', async () => {
    const timers: NodeJS.Timeout[] = [];
    const original = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => {
      const timer = original(callback, ms);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    vi.resetModules();

    await import('../src/twitch/sessions.js');

    expect(timers).toHaveLength(1);
    expect(timers[0]?.hasRef()).toBe(false);
    for (const timer of timers) clearInterval(timer);
  });
});
