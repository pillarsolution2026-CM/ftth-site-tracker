import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import type { FixedWindowRateLimiter } from '../application/fixed-window-rate-limiter.js';
import { AUTH_RATE_LIMITER, AUTH_RATE_LIMITS } from '../identity.tokens.js';

export type RateLimitedAction = 'login' | 'refresh';
export type AuthRateLimits = Record<RateLimitedAction, number>;

const ACTION_KEY = 'authRateLimitAction';
/** Marks a route as rate limited; `login` is keyed by IP + email, `refresh` by IP. */
export const AuthRateLimit = (action: RateLimitedAction) => SetMetadata(ACTION_KEY, action);

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
    @Inject(AUTH_RATE_LIMITS) private readonly limits: AuthRateLimits,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.get<RateLimitedAction | undefined>(
      ACTION_KEY,
      context.getHandler(),
    );
    if (!action) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const ip = request.ip ?? 'unknown';
    const key = action === 'login' ? `login:${ip}:${emailOf(request.body)}` : `${action}:${ip}`;

    const decision = this.limiter.hit(key, this.limits[action]);
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AppError('RATE_LIMITED');
  }
}

/** The body is not validated yet when guards run, so be defensive. */
function emailOf(body: unknown): string {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
