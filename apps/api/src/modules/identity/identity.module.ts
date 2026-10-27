import { Module } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { EVENT_LOG, type EventLog } from '../../common/event-log.port.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { FixedWindowRateLimiter } from './application/fixed-window-rate-limiter.js';
import { GetMeUseCase } from './application/get-me.use-case.js';
import { LoginUseCase } from './application/login.use-case.js';
import { LogoutUseCase } from './application/logout.use-case.js';
import type { Clock } from './application/ports.js';
import { RefreshUseCase } from './application/refresh.use-case.js';
import { ResolveProjectAccessUseCase } from './application/resolve-project-access.use-case.js';
import { SessionIssuer } from './application/session-issuer.js';
import type { MembershipRepository } from './domain/membership.js';
import type { RefreshTokenRepository } from './domain/refresh-token.js';
import type { UserRepository } from './domain/user.js';
import {
  ACCESS_TOKENS,
  AUTH_RATE_LIMITER,
  AUTH_RATE_LIMITS,
  GET_ME_USE_CASE,
  LOGIN_USE_CASE,
  LOGOUT_USE_CASE,
  MEMBERSHIP_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  REFRESH_USE_CASE,
  RESOLVE_PROJECT_ACCESS_USE_CASE,
  USER_REPOSITORY,
} from './identity.tokens.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { CryptoRefreshTokenFactory } from './infrastructure/crypto-refresh-token.factory.js';
import { DrizzleMembershipRepository } from './infrastructure/drizzle-membership.repository.js';
import { DrizzleRefreshTokenRepository } from './infrastructure/drizzle-refresh-token.repository.js';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository.js';
import { JwtAccessTokenService } from './infrastructure/jwt-access-token.service.js';
import { AuthRateLimitGuard, type AuthRateLimits } from './interface/auth-rate-limit.guard.js';
import { AuthController } from './interface/auth.controller.js';
import { JwtAuthGuard } from './interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from './interface/project-scope.guard.js';
import { RolesGuard } from './interface/roles.guard.js';

const systemClock: Clock = { now: () => new Date() };
const refreshFactory = new CryptoRefreshTokenFactory();

@Module({
  controllers: [AuthController],
  providers: [
    JwtAuthGuard,
    ProjectScopeGuard,
    RolesGuard,
    AuthRateLimitGuard,
    {
      provide: AUTH_RATE_LIMITER,
      inject: [APP_ENV],
      useFactory: (env: ApiEnv) =>
        new FixedWindowRateLimiter(systemClock, env.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000),
    },
    {
      provide: AUTH_RATE_LIMITS,
      inject: [APP_ENV],
      useFactory: (env: ApiEnv): AuthRateLimits => ({
        login: env.AUTH_LOGIN_RATE_LIMIT,
        refresh: env.AUTH_REFRESH_RATE_LIMIT,
      }),
    },
    {
      provide: ACCESS_TOKENS,
      inject: [APP_ENV],
      useFactory: (env: ApiEnv) =>
        new JwtAccessTokenService(env.JWT_ACCESS_SECRET, env.JWT_ACCESS_TTL_SECONDS),
    },
    {
      provide: USER_REPOSITORY,
      inject: [DB],
      useFactory: (db: Database) => new DrizzleUserRepository(db),
    },
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      inject: [DB],
      useFactory: (db: Database) => new DrizzleRefreshTokenRepository(db),
    },
    {
      provide: MEMBERSHIP_REPOSITORY,
      inject: [DB],
      useFactory: (db: Database) => new DrizzleMembershipRepository(db),
    },
    {
      provide: LOGIN_USE_CASE,
      inject: [USER_REPOSITORY, REFRESH_TOKEN_REPOSITORY, ACCESS_TOKENS, EVENT_LOG, APP_ENV],
      useFactory: (
        users: UserRepository,
        tokens: RefreshTokenRepository,
        access: JwtAccessTokenService,
        events: EventLog,
        env: ApiEnv,
      ) =>
        new LoginUseCase(
          users,
          new Argon2PasswordHasher(),
          new SessionIssuer(access, refreshFactory, tokens, systemClock, {
            accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
            refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
          }),
          events,
        ),
    },
    {
      provide: REFRESH_USE_CASE,
      inject: [USER_REPOSITORY, REFRESH_TOKEN_REPOSITORY, ACCESS_TOKENS, APP_ENV],
      useFactory: (
        users: UserRepository,
        tokens: RefreshTokenRepository,
        access: JwtAccessTokenService,
        env: ApiEnv,
      ) =>
        new RefreshUseCase(
          tokens,
          refreshFactory,
          users,
          new SessionIssuer(access, refreshFactory, tokens, systemClock, {
            accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
            refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
          }),
          systemClock,
        ),
    },
    {
      provide: LOGOUT_USE_CASE,
      inject: [REFRESH_TOKEN_REPOSITORY],
      useFactory: (tokens: RefreshTokenRepository) =>
        new LogoutUseCase(tokens, refreshFactory, systemClock),
    },
    {
      provide: GET_ME_USE_CASE,
      inject: [USER_REPOSITORY, MEMBERSHIP_REPOSITORY],
      useFactory: (users: UserRepository, memberships: MembershipRepository) =>
        new GetMeUseCase(users, memberships),
    },
    {
      provide: RESOLVE_PROJECT_ACCESS_USE_CASE,
      inject: [MEMBERSHIP_REPOSITORY],
      useFactory: (memberships: MembershipRepository) =>
        new ResolveProjectAccessUseCase(memberships),
    },
  ],
  exports: [
    ACCESS_TOKENS,
    RESOLVE_PROJECT_ACCESS_USE_CASE,
    JwtAuthGuard,
    ProjectScopeGuard,
    RolesGuard,
  ],
})
export class IdentityModule {}
