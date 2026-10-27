import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  LoginRequestSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  TokenPairSchema,
  type LoginRequest,
  type MeResponse,
  type RefreshRequest,
  type TokenPair,
} from '@ftth/shared';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import type { GetMeUseCase } from '../application/get-me.use-case.js';
import type { LoginUseCase } from '../application/login.use-case.js';
import type { LogoutUseCase } from '../application/logout.use-case.js';
import type { RefreshUseCase } from '../application/refresh.use-case.js';
import {
  GET_ME_USE_CASE,
  LOGIN_USE_CASE,
  LOGOUT_USE_CASE,
  REFRESH_USE_CASE,
} from '../identity.tokens.js';
import type { AuthenticatedRequest } from './auth-request.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(LOGIN_USE_CASE) private readonly login: LoginUseCase,
    @Inject(REFRESH_USE_CASE) private readonly refresh: RefreshUseCase,
    @Inject(LOGOUT_USE_CASE) private readonly logout: LogoutUseCase,
    @Inject(GET_ME_USE_CASE) private readonly getMe: GetMeUseCase,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(LoginRequestSchema) })
  @ApiOkResponse({ schema: openApiSchema(TokenPairSchema) })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS' })
  loginUser(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
  ): Promise<TokenPair> {
    return this.login.execute(body);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(RefreshRequestSchema) })
  @ApiOkResponse({ schema: openApiSchema(TokenPairSchema) })
  @ApiResponse({ status: 401, description: 'TOKEN_INVALID | TOKEN_EXPIRED | REFRESH_TOKEN_REUSED' })
  refreshTokens(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
  ): Promise<TokenPair> {
    return this.refresh.execute(body);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBody({ schema: openApiSchema(RefreshRequestSchema) })
  @ApiResponse({ status: 204, description: 'Token family revoked' })
  logoutUser(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
  ): Promise<void> {
    return this.logout.execute(body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ schema: openApiSchema(MeResponseSchema) })
  me(@Req() request: AuthenticatedRequest): Promise<MeResponse> {
    // JwtAuthGuard guarantees `auth`.
    return this.getMe.execute(request.auth?.sub ?? '');
  }
}
