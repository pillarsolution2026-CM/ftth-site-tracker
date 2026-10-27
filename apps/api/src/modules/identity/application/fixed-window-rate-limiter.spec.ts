import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter.js';

function setup() {
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const limiter = new FixedWindowRateLimiter({ now: () => new Date(nowMs) }, 60_000);
  return { limiter, advance: (ms: number) => (nowMs += ms) };
}

describe('FixedWindowRateLimiter', () => {
  it('rejects the 6th hit within the window', () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) expect(limiter.hit('k', 5).allowed).toBe(true);
    const sixth = limiter.hit('k', 5);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBe(60);
  });

  it('reports the remaining time in the window', () => {
    const { limiter, advance } = setup();
    limiter.hit('k', 1);
    advance(45_500);
    expect(limiter.hit('k', 1).retryAfterSeconds).toBe(15);
  });

  it('resets after the window elapses', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 6; i++) limiter.hit('k', 5);
    advance(60_000);
    expect(limiter.hit('k', 5).allowed).toBe(true);
  });

  it('counts keys separately', () => {
    const { limiter } = setup();
    for (let i = 0; i < 6; i++) limiter.hit('a', 5);
    expect(limiter.hit('a', 5).allowed).toBe(false);
    expect(limiter.hit('b', 5).allowed).toBe(true);
  });
});
