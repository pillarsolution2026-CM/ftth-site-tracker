import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { APP_ENV } from '../../config/config.module.js';
import { FixedWindowRateLimiter } from '../identity/application/fixed-window-rate-limiter.js';
import { systemClock, uuidGenerator, type Clock } from '../../common/clock.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { Phase2UnavailableCapabilities } from './application/phase2-capabilities.js';
import {
  DiscardIdleUploadsUseCase,
  GetPhotoUploadStatusUseCase,
  PutPhotoChunkUseCase,
} from './application/photo-upload.use-cases.js';
import type {
  ExecutionCapabilities,
  ExecutionReadQueries,
  ExecutionUnitOfWork,
  PhotoUploadUnitOfWork,
} from './application/ports.js';
import { PushSyncUseCase } from './application/push-sync.use-case.js';
import {
  GetOfflineBundleUseCase,
  GetSyncChangesUseCase,
} from './application/sync-queries.use-cases.js';
import {
  EXECUTION_CAPABILITIES,
  EXECUTION_CLOCK,
  EXECUTION_READ_QUERIES,
  EXECUTION_UNIT_OF_WORK,
  PHOTO_UPLOAD_UNIT_OF_WORK,
  SYNC_RATE_LIMITER,
  SYNC_RATE_LIMITS,
} from './execution.tokens.js';
import { DrizzleExecutionReadQueries } from './infrastructure/drizzle-execution-read.queries.js';
import { DrizzleExecutionUnitOfWork } from './infrastructure/drizzle-execution.repository.js';
import { DrizzlePhotoUploadUnitOfWork } from './infrastructure/drizzle-photo-upload.repository.js';
import { SyncController } from './interface/sync.controller.js';
import { SyncRateLimitGuard, type SyncRateLimits } from './interface/sync-rate-limit.guard.js';

const providers: Provider[] = [
  PermissionGuard,
  SyncRateLimitGuard,
  {
    provide: SYNC_RATE_LIMITER,
    useFactory: () => new FixedWindowRateLimiter(systemClock, 60_000),
  },
  {
    provide: SYNC_RATE_LIMITS,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv): SyncRateLimits => ({
      sync: env.SYNC_RATE_LIMIT,
      upload: env.SYNC_UPLOAD_RATE_LIMIT,
    }),
  },
  { provide: EXECUTION_CLOCK, useValue: systemClock },
  // Phase 2 replaces this provider with one backed by type_rules (ADR-023).
  { provide: EXECUTION_CAPABILITIES, useClass: Phase2UnavailableCapabilities },
  {
    provide: EXECUTION_UNIT_OF_WORK,
    inject: [DB, APP_ENV],
    useFactory: (db: Database, env: ApiEnv) =>
      new DrizzleExecutionUnitOfWork(db, env.SYNC_LOCK_TIMEOUT_MS),
  },
  {
    provide: EXECUTION_READ_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleExecutionReadQueries(db),
  },
  {
    provide: PHOTO_UPLOAD_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzlePhotoUploadUnitOfWork(db),
  },
  {
    provide: PushSyncUseCase,
    inject: [EXECUTION_UNIT_OF_WORK, EXECUTION_CAPABILITIES, EXECUTION_CLOCK],
    useFactory: (uow: ExecutionUnitOfWork, caps: ExecutionCapabilities, clock: Clock) =>
      new PushSyncUseCase(uow, caps, clock, uuidGenerator),
  },
  {
    provide: GetOfflineBundleUseCase,
    inject: [EXECUTION_READ_QUERIES, EXECUTION_CAPABILITIES, EXECUTION_CLOCK],
    useFactory: (queries: ExecutionReadQueries, caps: ExecutionCapabilities, clock: Clock) =>
      new GetOfflineBundleUseCase(queries, caps, clock),
  },
  {
    provide: GetSyncChangesUseCase,
    inject: [EXECUTION_READ_QUERIES, EXECUTION_CLOCK],
    useFactory: (queries: ExecutionReadQueries, clock: Clock) =>
      new GetSyncChangesUseCase(queries, clock),
  },
  {
    provide: GetPhotoUploadStatusUseCase,
    inject: [PHOTO_UPLOAD_UNIT_OF_WORK],
    useFactory: (uow: PhotoUploadUnitOfWork) => new GetPhotoUploadStatusUseCase(uow),
  },
  {
    provide: PutPhotoChunkUseCase,
    inject: [PHOTO_UPLOAD_UNIT_OF_WORK, OBJECT_STORAGE, EXECUTION_CLOCK, APP_ENV],
    useFactory: (uow: PhotoUploadUnitOfWork, storage: ObjectStorage, clock: Clock, env: ApiEnv) =>
      new PutPhotoChunkUseCase(uow, storage, clock, env.SYNC_UPLOAD_BACKLOG_MB * 1024 * 1024),
  },
  {
    provide: DiscardIdleUploadsUseCase,
    inject: [PHOTO_UPLOAD_UNIT_OF_WORK, EXECUTION_CLOCK, APP_ENV],
    useFactory: (uow: PhotoUploadUnitOfWork, clock: Clock, env: ApiEnv) =>
      new DiscardIdleUploadsUseCase(uow, clock, env.SYNC_STALE_UPLOAD_HOURS * 3_600_000),
  },
];

/** Phase 3: offline execution updates, idempotent sync and resumable photos (ADR-024). */
@Module({
  imports: [IdentityModule],
  controllers: [SyncController],
  providers,
})
export class ExecutionModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExecutionModule.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DiscardIdleUploadsUseCase) private readonly discardIdle: DiscardIdleUploadsUseCase,
  ) {}

  /** Hourly sweep of abandoned partial uploads (security review M3). */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.discardIdle
        .execute()
        .then((count) => {
          if (count > 0) this.logger.log(`Discarded ${count} idle photo upload(s)`);
        })
        .catch((error: unknown) => this.logger.error(`Idle upload sweep failed: ${String(error)}`));
    }, 3_600_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
