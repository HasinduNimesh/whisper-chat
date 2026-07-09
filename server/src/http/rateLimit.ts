/**
 * Fixed-window rate limiting for stateless HTTP requests (the WS side has
 * its own per-socket token bucket). One limiter instance per concern; keys
 * are typically client IPs, but any string works (e.g. login emails).
 */

interface Window {
  count: number;
  windowStart: number;
}

export interface FixedWindowLimiter {
  /** Consume one unit for `key`; false when the window is exhausted. */
  allow(key: string): boolean;
}

const allLimiters: Map<string, Window>[] = [];

export function makeFixedWindowLimiter(opts: { limit: number; windowMs: number }): FixedWindowLimiter {
  const windows = new Map<string, Window>();
  allLimiters.push(windows);
  return {
    allow(key: string): boolean {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || now - w.windowStart > opts.windowMs) {
        // Opportunistic GC: reset windows churn out naturally, but a scan
        // here keeps the map bounded under key-rotation abuse.
        if (windows.size > 10_000) {
          for (const [k, v] of windows) {
            if (now - v.windowStart > opts.windowMs) windows.delete(k);
          }
        }
        windows.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (w.count >= opts.limit) return false;
      w.count += 1;
      return true;
    },
  };
}

/** Test hook: clear every limiter's state for deterministic 429 tests. */
export function resetRateLimitersForTests(): void {
  for (const windows of allLimiters) windows.clear();
}
