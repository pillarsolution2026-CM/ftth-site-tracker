import { Module, type Provider } from '@nestjs/common';
import { systemClock, uuidGenerator, type Clock } from '../../common/clock.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { Phase2UnavailableCapabilities } from './application/phase2-capabilities.js';
import {
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
} from './execution.tokens.js';
import { DrizzleExecutionReadQueries } from './infrastructure/drizzle-execution-read.queries.js';
import { DrizzleExecutionUnitOfWork } from './infrastructure/drizzle-execution.repository.js';
import { DrizzlePhotoUploadUnitOfWork } from './infrastructure/drizzle-photo-upload.repository.js';
import { SyncController } from './interface/sync.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  { provide: EXECUTION_CLOCK, useValue: systemClock },
  // Phase 2 replaces this provider with one backed by type_rules (ADR-023).
  { provide: EXECUTION_CAPABILITIES, useClass: Phase2UnavailableCapabilities },
  {
    provide: EXECUTION_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleExecutionUnitOfWork(db),
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
    inject: [PHOTO_UPLOAD_UNIT_OF_WORK, OBJECT_STORAGE, EXECUTION_CLOCK],
    useFactory: (uow: PhotoUploadUnitOfWork, storage: ObjectStorage, clock: Clock) =>
      new PutPhotoChunkUseCase(uow, storage, clock),
  },
];

/** Phase 3: offline execution updates, idempotent sync and resumable photos (ADR-024). */
@Module({
  imports: [IdentityModule],
  controllers: [SyncController],
  providers,
})
export class ExecutionModule {}
