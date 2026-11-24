import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import type { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { CONTRACTOR_ACCOUNT_RATE_LIMITER } from '../contractors.tokens.js';

/** Technical limit, generous: account creations per admin in one window. */
export const CONTRACTOR_ACCOUNT_CREATE_LIMIT = 30;
export const CONTRACTOR_ACCOUNT_CREATE_WINDOW_MS = 10 * 60 * 1000;

/** Requires JwtAuthGuard first: limits account creation per authenticated actor. */
@Injectable()
export class ContractorAccountCreateRateLimitGuard implements CanActivate {
  constructor(
    @Inject(CONTRACTOR_ACCOUNT_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const actor = http.getRequest<AuthenticatedRequest>().auth?.sub;
    if (!actor) throw new AppError('TOKEN_INVALID', 'Authentication required');
    const decision = this.limiter.hit(
      `contractor-account:${actor}`,
      CONTRACTOR_ACCOUNT_CREATE_LIMIT,
    );
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AppError('RATE_LIMITED');
  }
}
