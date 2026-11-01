import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import type { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { ASBUILT_RATE_LIMIT, ASBUILT_RATE_LIMITER } from '../asbuilt.tokens.js';

/**
 * Per-user fixed window over every As-Built web route (security review M2): review writes take
 * the project lock and exports feed the shared CAD queue. Same budget as the sync routes
 * (`SYNC_RATE_LIMIT`), counted separately. Use after JwtAuthGuard. 429 RATE_LIMITED + Retry-After.
 */
@Injectable()
export class AsBuiltRateLimitGuard implements CanActivate {
  constructor(
    @Inject(ASBUILT_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
    @Inject(ASBUILT_RATE_LIMIT) private readonly limit: number,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
    const decision = this.limiter.hit(`asbuilt:${request.auth.sub}`, this.limit);
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AppError('RATE_LIMITED');
  }
}
