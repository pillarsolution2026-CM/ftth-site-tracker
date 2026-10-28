import { Controller, Get, Headers, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiHeader, ApiNoContentResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppError } from '../../../common/app-error.js';
import { VerifyTileRequestUseCase } from '../application/tiles.use-cases.js';

/**
 * Called by Caddy `forward_auth` for every tile request (ADR-021). No JWT, no rate limit, no
 * database: the signature in the URL is the credential.
 */
@ApiTags('tiles')
@Controller('tiles')
export class TilesVerifyController {
  constructor(
    @Inject(VerifyTileRequestUseCase) private readonly verify: VerifyTileRequestUseCase,
  ) {}

  @Get('verify')
  @HttpCode(204)
  @ApiHeader({
    name: 'X-Forwarded-Uri',
    description: 'Original tile URI, set by Caddy forward_auth',
  })
  @ApiNoContentResponse({ description: 'The signed tile URL is valid' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired or tampered signature' })
  check(
    @Headers('x-forwarded-uri') forwardedUri: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): void {
    response.setHeader('Cache-Control', 'no-store');
    if (!this.verify.execute(forwardedUri)) {
      throw new AppError('TOKEN_INVALID', 'Invalid or expired tile signature');
    }
  }
}
