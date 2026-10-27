import { AppError } from '../app-error.js';

/** Id of the authenticated user (set by JwtAuthGuard); recorded as the actor of every event. */
export function actorIdOf(request: { auth?: { sub: string } }): string {
  if (!request.auth) throw new AppError('TOKEN_INVALID', 'Authentication required');
  return request.auth.sub;
}
