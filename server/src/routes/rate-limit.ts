// Fixed-window request limiter for public routes that spend the app's Twitch quota.
// Process memory only, and bounded, so distinct callers cannot grow it without limit.

export interface RateLimit {
  windowMs: number;
  max: number;
  maxKeys: number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createRateLimiter(limit: RateLimit, now: () => number = Date.now) {
  const windows = new Map<string, { startedAtMs: number; count: number }>();
  return (key: string): RateDecision => {
    const nowMs = now();
    const current = windows.get(key);
    if (!current || nowMs - current.startedAtMs >= limit.windowMs) {
      // Re-inserting keeps recently started windows last, so trimming drops the oldest.
      windows.delete(key);
      windows.set(key, { startedAtMs: nowMs, count: 1 });
      if (windows.size > limit.maxKeys) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      return { allowed: true };
    }
    if (current.count >= limit.max) {
      return { allowed: false, retryAfterSeconds: Math.ceil((current.startedAtMs + limit.windowMs - nowMs) / 1_000) };
    }
    current.count += 1;
    return { allowed: true };
  };
}
