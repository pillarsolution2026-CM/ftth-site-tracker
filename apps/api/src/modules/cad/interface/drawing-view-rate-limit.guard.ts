import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import type { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { DRAWING_VIEW_RATE_BUDGET, DRAWING_VIEW_RATE_LIMITER } from '../cad.tokens.js';

/**
 * Per-user fixed window over the routes that queue a drawing view render: each one feeds the
 * shared CAD queue. Use after JwtAuthGuard. 429 RATE_LIMITED + Retry-After.
 */
@Injectable()
export class DrawingViewRateLimitGuard implements CanActivate {
  constructor(
    @Inject(DRAWING_VIEW_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
    @Inject(DRAWING_VIEW_RATE_BUDGET) private readonly limit: number,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
    const decision = this.limiter.hit(`drawing-view:${request.auth.sub}`, this.limit);
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AppError('RATE_LIMITED');
  }
}
