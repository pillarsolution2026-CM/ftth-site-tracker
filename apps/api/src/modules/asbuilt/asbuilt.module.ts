import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  DownloadAsBuiltExportUseCase,
  GetAsBuiltExportUseCase,
  ListAsBuiltExportsUseCase,
  RequestAsBuiltExportUseCase,
} from './application/export.use-cases.js';
import type {
  AsBuiltExportQueries,
  AsBuiltExportUnitOfWork,
  AsBuiltJobQueue,
  AsBuiltLengthsPort,
  AsBuiltReadQueries,
  AsBuiltReviewUnitOfWork,
} from './application/ports.js';
import {
  GetAsBuiltEditUseCase,
  GetAsBuiltLengthsUseCase,
  GetAsBuiltStateUseCase,
  ListAsBuiltEditsUseCase,
} from './application/query.use-cases.js';
import {
  ApproveAsBuiltEditUseCase,
  RejectAsBuiltEditUseCase,
} from './application/review.use-cases.js';
import {
  ASBUILT_EDIT_FEED,
  ASBUILT_EXPORT_QUERIES,
  ASBUILT_EXPORT_UNIT_OF_WORK,
  ASBUILT_JOB_QUEUE,
  ASBUILT_LENGTHS_PORT,
  ASBUILT_READ_QUERIES,
  ASBUILT_REVIEW_UNIT_OF_WORK,
  ASBUILT_STATE_READER,
} from './asbuilt.tokens.js';
import {
  DrizzleAsBuiltExportQueries,
  DrizzleAsBuiltExportUnitOfWork,
} from './infrastructure/drizzle-asbuilt-export.repository.js';
import { DrizzleAsBuiltReadQueries } from './infrastructure/drizzle-asbuilt-read.queries.js';
import { DrizzleAsBuiltReviewUnitOfWork } from './infrastructure/drizzle-asbuilt-review.repository.js';
import { RedisAsBuiltJobQueue } from './infrastructure/redis-asbuilt-job-queue.js';
import { AsBuiltController } from './interface/asbuilt.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  {
    provide: ASBUILT_READ_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleAsBuiltReadQueries(db),
  },
  // One implementation behind the three read ports other modules may use.
  { provide: ASBUILT_LENGTHS_PORT, useExisting: ASBUILT_READ_QUERIES },
  { provide: ASBUILT_EDIT_FEED, useExisting: ASBUILT_READ_QUERIES },
  { provide: ASBUILT_STATE_READER, useExisting: ASBUILT_READ_QUERIES },
  {
    provide: ASBUILT_REVIEW_UNIT_OF_WORK,
    inject: [DB, APP_ENV],
    useFactory: (db: Database, env: ApiEnv) =>
      new DrizzleAsBuiltReviewUnitOfWork(db, env.SYNC_LOCK_TIMEOUT_MS),
  },
  {
    provide: ASBUILT_EXPORT_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleAsBuiltExportUnitOfWork(db),
  },
  {
    provide: ASBUILT_EXPORT_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleAsBuiltExportQueries(db),
  },
  {
    provide: ASBUILT_JOB_QUEUE,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv) => new RedisAsBuiltJobQueue(env.REDIS_URL),
  },
  {
    provide: ListAsBuiltEditsUseCase,
    inject: [ASBUILT_READ_QUERIES],
    useFactory: (queries: AsBuiltReadQueries) => new ListAsBuiltEditsUseCase(queries),
  },
  {
    provide: GetAsBuiltEditUseCase,
    inject: [ASBUILT_READ_QUERIES],
    useFactory: (queries: AsBuiltReadQueries) => new GetAsBuiltEditUseCase(queries),
  },
  {
    provide: GetAsBuiltStateUseCase,
    inject: [ASBUILT_READ_QUERIES],
    useFactory: (queries: AsBuiltReadQueries) => new GetAsBuiltStateUseCase(queries),
  },
  {
    provide: GetAsBuiltLengthsUseCase,
    inject: [ASBUILT_LENGTHS_PORT],
    useFactory: (lengths: AsBuiltLengthsPort) => new GetAsBuiltLengthsUseCase(lengths),
  },
  {
    provide: ApproveAsBuiltEditUseCase,
    inject: [ASBUILT_REVIEW_UNIT_OF_WORK],
    useFactory: (uow: AsBuiltReviewUnitOfWork) => new ApproveAsBuiltEditUseCase(uow, systemClock),
  },
  {
    provide: RejectAsBuiltEditUseCase,
    inject: [ASBUILT_REVIEW_UNIT_OF_WORK],
    useFactory: (uow: AsBuiltReviewUnitOfWork) => new RejectAsBuiltEditUseCase(uow, systemClock),
  },
  {
    provide: RequestAsBuiltExportUseCase,
    inject: [ASBUILT_EXPORT_UNIT_OF_WORK, ASBUILT_JOB_QUEUE],
    useFactory: (uow: AsBuiltExportUnitOfWork, queue: AsBuiltJobQueue) =>
      new RequestAsBuiltExportUseCase(uow, queue, systemClock, uuidGenerator),
  },
  {
    provide: ListAsBuiltExportsUseCase,
    inject: [ASBUILT_EXPORT_QUERIES],
    useFactory: (queries: AsBuiltExportQueries) => new ListAsBuiltExportsUseCase(queries),
  },
  {
    provide: GetAsBuiltExportUseCase,
    inject: [ASBUILT_EXPORT_QUERIES],
    useFactory: (queries: AsBuiltExportQueries) => new GetAsBuiltExportUseCase(queries),
  },
  {
    provide: DownloadAsBuiltExportUseCase,
    inject: [ASBUILT_EXPORT_QUERIES, OBJECT_STORAGE],
    useFactory: (queries: AsBuiltExportQueries, storage: ObjectStorage) =>
      new DownloadAsBuiltExportUseCase(queries, storage),
  },
];

/** Phase 4: review of As-Built edits, approved state and lengths, As-Built DXF export (ADR-030). */
@Module({
  imports: [IdentityModule],
  controllers: [AsBuiltController],
  providers,
  exports: [ASBUILT_LENGTHS_PORT, ASBUILT_EDIT_FEED, ASBUILT_STATE_READER],
})
export class AsBuiltModule implements OnApplicationShutdown {
  constructor(@Inject(ASBUILT_JOB_QUEUE) private readonly queue: AsBuiltJobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.queue instanceof RedisAsBuiltJobQueue) await this.queue.close();
  }
}
