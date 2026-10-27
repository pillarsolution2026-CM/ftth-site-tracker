import type { Clock } from './ports.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window ends (>= 1). */
  retryAfterSeconds: number;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/** In-memory fixed-window limiter. Single API instance only (state is per process). */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number,
  ) {}

  /** Counts one attempt for `key` against `limit` per window. */
  hit(key: string, limit: number): RateLimitDecision {
    const nowMs = this.clock.now().getTime();
    this.prune(nowMs);
    let window = this.windows.get(key);
    if (!window || nowMs - window.startedAtMs >= this.windowMs) {
      window = { startedAtMs: nowMs, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAtMs + this.windowMs - nowMs) / 1000),
    );
    return { allowed: window.count <= limit, retryAfterSeconds };
  }

  private prune(nowMs: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, window] of this.windows) {
      if (nowMs - window.startedAtMs >= this.windowMs) this.windows.delete(key);
    }
  }
}
