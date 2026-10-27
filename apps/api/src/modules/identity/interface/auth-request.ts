import type { AccessTokenClaims } from '@ftth/shared';
import type { Request } from 'express';
import type { ProjectAccess } from '../domain/membership.js';

/** Request enriched by JwtAuthGuard (`auth`) and ProjectScopeGuard (`projectAccess`). */
export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenClaims;
  projectAccess?: ProjectAccess;
}
