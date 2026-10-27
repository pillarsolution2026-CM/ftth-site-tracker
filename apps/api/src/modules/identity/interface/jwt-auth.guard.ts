import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/app-error.js';
import type { AccessTokenService } from '../application/ports.js';
import { ACCESS_TOKENS } from '../identity.tokens.js';
import type { AuthenticatedRequest } from './auth-request.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(ACCESS_TOKENS) private readonly accessTokens: AccessTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppError('TOKEN_INVALID', 'Missing bearer token');
    }
    request.auth = this.accessTokens.verify(token);
    return true;
  }
}
