import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import type { FixedWindowRateLimiter } from '../../identity/application/fixed-window-rate-limiter.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { SYNC_RATE_LIMITER, SYNC_RATE_LIMITS } from '../execution.tokens.js';

export type SyncRateBucket = 'sync' | 'upload';
export type SyncRateLimits = Record<SyncRateBucket, number>;

const BUCKET_KEY = 'syncRateBucket';
/** Counts the route against the caller's per-user budget (security review M4). */
export const SyncRateLimit = (bucket: SyncRateBucket) => SetMetadata(BUCKET_KEY, bucket);

/** Per-user fixed window; use after JwtAuthGuard. 429 RATE_LIMITED with Retry-After. */
@Injectable()
export class SyncRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SYNC_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter,
    @Inject(SYNC_RATE_LIMITS) private readonly limits: SyncRateLimits,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const bucket = this.reflector.get<SyncRateBucket | undefined>(BUCKET_KEY, context.getHandler());
    // Fail closed: every sync route declares its bucket.
    if (!bucket) throw new AppError('FORBIDDEN', 'No rate limit declared for this route');
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
    const decision = this.limiter.hit(`${bucket}:${request.auth.sub}`, this.limits[bucket]);
    if (decision.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(decision.retryAfterSeconds));
    throw new AppError('RATE_LIMITED');
  }
}
