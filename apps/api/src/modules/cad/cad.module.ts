import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { maxUploadBytes } from '../../common/http/multipart-payload.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  CadExtractionUseCases,
  GetCadFileContentUseCase,
  GetCadFileLogUseCase,
  GetCadFileUseCase,
  ListCadFilesUseCase,
} from './application/cad-queries.use-cases.js';
import type { JobQueue } from './application/ports.js';
import { ReprocessCadFileUseCase } from './application/reprocess-cad-file.use-case.js';
import { UploadCadFileUseCase } from './application/upload-cad-file.use-case.js';
import {
  CAD_EXTRACTION_QUERIES,
  CAD_FILE_REPOSITORY,
  CAD_UNIT_OF_WORK,
  JOB_QUEUE,
} from './cad.tokens.js';
import type {
  CadExtractionQueries,
  CadFileRepository,
  CadUnitOfWork,
} from './domain/cad-file.repository.js';
import { DrizzleCadExtractionQueries } from './infrastructure/drizzle-cad-extraction.queries.js';
import { DrizzleCadFileRepository } from './infrastructure/drizzle-cad-file.repository.js';
import { DrizzleCadUnitOfWork } from './infrastructure/drizzle-cad.unit-of-work.js';
import { RedisJobQueue } from './infrastructure/redis-job-queue.js';
import { CadExtractionController } from './interface/cad-extraction.controller.js';
import { CadFilesController } from './interface/cad-files.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  {
    provide: JOB_QUEUE,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv) => new RedisJobQueue(env.REDIS_URL),
  },
  {
    provide: CAD_FILE_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleCadFileRepository(db),
  },
  {
    provide: CAD_EXTRACTION_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleCadExtractionQueries(db),
  },
  {
    provide: CAD_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleCadUnitOfWork(db),
  },
  {
    provide: UploadCadFileUseCase,
    inject: [CAD_UNIT_OF_WORK, OBJECT_STORAGE, JOB_QUEUE, APP_ENV],
    useFactory: (uow: CadUnitOfWork, storage: ObjectStorage, queue: JobQueue, env: ApiEnv) =>
      new UploadCadFileUseCase(
        uow,
        storage,
        queue,
        systemClock,
        uuidGenerator,
        maxUploadBytes(env.MAX_UPLOAD_MB),
      ),
  },
  {
    provide: ReprocessCadFileUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue) =>
      new ReprocessCadFileUseCase(uow, queue, systemClock, uuidGenerator),
  },
  {
    provide: ListCadFilesUseCase,
    inject: [CAD_FILE_REPOSITORY],
    useFactory: (files: CadFileRepository) => new ListCadFilesUseCase(files),
  },
  {
    provide: GetCadFileUseCase,
    inject: [CAD_FILE_REPOSITORY],
    useFactory: (files: CadFileRepository) => new GetCadFileUseCase(files),
  },
  {
    provide: GetCadFileContentUseCase,
    inject: [CAD_FILE_REPOSITORY, OBJECT_STORAGE],
    useFactory: (files: CadFileRepository, storage: ObjectStorage) =>
      new GetCadFileContentUseCase(files, storage),
  },
  {
    provide: GetCadFileLogUseCase,
    inject: [CAD_FILE_REPOSITORY],
    useFactory: (files: CadFileRepository) => new GetCadFileLogUseCase(files),
  },
  {
    provide: CadExtractionUseCases,
    inject: [CAD_FILE_REPOSITORY, CAD_EXTRACTION_QUERIES],
    useFactory: (files: CadFileRepository, queries: CadExtractionQueries) =>
      new CadExtractionUseCases(files, queries),
  },
];

@Module({
  imports: [IdentityModule],
  controllers: [CadFilesController, CadExtractionController],
  providers,
})
export class CadModule implements OnApplicationShutdown {
  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.queue instanceof RedisJobQueue) await this.queue.close();
  }
}
