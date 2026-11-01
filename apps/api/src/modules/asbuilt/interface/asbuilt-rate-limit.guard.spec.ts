import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import { AsBuiltRateLimitGuard } from './asbuilt-rate-limit.guard.js';

function contextFor(auth?: { sub: string }) {
  const headers: Record<string, string> = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ auth }),
      getResponse: () => ({ setHeader: (name: string, value: string) => (headers[name] = value) }),
    }),
  } as unknown as ExecutionContext;
  return { headers, context };
}

describe('AsBuiltRateLimitGuard (security review M2)', () => {
  const guard = () =>
    new AsBuiltRateLimitGuard(new FixedWindowRateLimiter({ now: () => new Date(0) }, 60_000), 2);

  it('counts per user and answers 429 with Retry-After over budget', () => {
    const g = guard();
    expect(g.canActivate(contextFor({ sub: 'u1' }).context)).toBe(true);
    expect(g.canActivate(contextFor({ sub: 'u1' }).context)).toBe(true);
    const over = contextFor({ sub: 'u1' });
    expect(() => g.canActivate(over.context)).toThrow(AppError);
    expect(over.headers['Retry-After']).toBeDefined();
    expect(g.canActivate(contextFor({ sub: 'u2' }).context)).toBe(true);
  });

  it('fails closed without authentication', () => {
    expect(() => guard().canActivate(contextFor().context)).toThrow(AppError);
  });
});
