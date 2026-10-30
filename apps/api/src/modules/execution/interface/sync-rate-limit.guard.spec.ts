import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import { SyncRateLimit, SyncRateLimitGuard } from './sync-rate-limit.guard.js';

class Handlers {
  @SyncRateLimit('upload')
  limited(): void {}
  undeclared(): void {}
}

function contextFor(handler: () => void, auth?: { sub: string }) {
  const headers: Record<string, string> = {};
  return {
    headers,
    context: {
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ auth }),
        getResponse: () => ({
          setHeader: (name: string, value: string) => (headers[name] = value),
        }),
      }),
    } as unknown as ExecutionContext,
  };
}

const guard = () =>
  new SyncRateLimitGuard(
    new Reflector(),
    new FixedWindowRateLimiter({ now: () => new Date(0) }, 60_000),
    { sync: 1, upload: 2 },
  );

describe('SyncRateLimitGuard', () => {
  it('counts per user and bucket and sets Retry-After when over budget', () => {
    const g = guard();
    const proto = Handlers.prototype;
    expect(g.canActivate(contextFor(proto.limited, { sub: 'u1' }).context)).toBe(true);
    expect(g.canActivate(contextFor(proto.limited, { sub: 'u1' }).context)).toBe(true);
    const third = contextFor(proto.limited, { sub: 'u1' });
    expect(() => g.canActivate(third.context)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    expect(third.headers['Retry-After']).toBe('60');
    expect(g.canActivate(contextFor(proto.limited, { sub: 'u2' }).context)).toBe(true);
  });

  it('fails closed without a declared bucket or an authenticated user', () => {
    const proto = Handlers.prototype;
    expect(() => guard().canActivate(contextFor(proto.undeclared, { sub: 'u' }).context)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => guard().canActivate(contextFor(proto.limited).context)).toThrow(
      expect.objectContaining({ code: 'TOKEN_INVALID' }),
    );
  });
});
