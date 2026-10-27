import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import { FixedWindowRateLimiter } from '../application/fixed-window-rate-limiter.js';
import { AuthRateLimit, AuthRateLimitGuard } from './auth-rate-limit.guard.js';

class Handlers {
  @AuthRateLimit('login')
  login(): void {}

  @AuthRateLimit('refresh')
  refresh(): void {}

  other(): void {}
}
const proto = Handlers.prototype;

function setup() {
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  const limiter = new FixedWindowRateLimiter({ now: () => new Date(nowMs) }, 60_000);
  const guard = new AuthRateLimitGuard(new Reflector(), limiter, { login: 5, refresh: 30 });
  const setHeader = vi.fn();
  const call = (handler: () => void, ip: string, body: unknown = {}) =>
    guard.canActivate({
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ ip, body }),
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext);
  return { call, setHeader, advance: (ms: number) => (nowMs += ms) };
}

describe('AuthRateLimitGuard', () => {
  it('blocks the 6th login for the same ip and email with 429 and Retry-After', () => {
    const { call, setHeader } = setup();
    for (let i = 0; i < 5; i++)
      expect(call(proto.login, '1.1.1.1', { email: 'a@x.io' })).toBe(true);
    let error: unknown;
    try {
      call(proto.login, '1.1.1.1', { email: 'a@x.io' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect((error as AppError).httpStatus).toBe(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('treats email case-insensitively', () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) call(proto.login, '1.1.1.1', { email: 'A@x.io' });
    expect(() => call(proto.login, '1.1.1.1', { email: ' a@X.io ' })).toThrow(AppError);
  });

  it('counts different emails and different ips separately', () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) call(proto.login, '1.1.1.1', { email: 'a@x.io' });
    expect(call(proto.login, '1.1.1.1', { email: 'b@x.io' })).toBe(true);
    expect(call(proto.login, '2.2.2.2', { email: 'a@x.io' })).toBe(true);
  });

  it('resets after a minute', () => {
    const { call, advance } = setup();
    for (let i = 0; i < 5; i++) call(proto.login, '1.1.1.1', { email: 'a@x.io' });
    expect(() => call(proto.login, '1.1.1.1', { email: 'a@x.io' })).toThrow(AppError);
    advance(60_000);
    expect(call(proto.login, '1.1.1.1', { email: 'a@x.io' })).toBe(true);
  });

  it('limits refresh to 30 per ip regardless of body', () => {
    const { call } = setup();
    for (let i = 0; i < 30; i++) call(proto.refresh, '1.1.1.1', { refreshToken: String(i) });
    expect(() => call(proto.refresh, '1.1.1.1')).toThrow(AppError);
    expect(call(proto.refresh, '2.2.2.2')).toBe(true);
  });

  it('survives a malformed body and ignores unmarked routes', () => {
    const { call } = setup();
    expect(call(proto.login, '1.1.1.1', 'garbage')).toBe(true);
    expect(call(proto.login, '1.1.1.1', undefined)).toBe(true);
    for (let i = 0; i < 100; i++) expect(call(proto.other, '1.1.1.1')).toBe(true);
  });
});
