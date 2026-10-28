import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { maxUploadBytes } from '../../common/http/multipart-payload.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import type { GetProjectUseCase } from '../projects/application/get-project.use-case.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { GET_PROJECT_USE_CASE } from '../projects/projects.tokens.js';
import {
  CadExtractionUseCases,
  GetCadFileContentUseCase,
  GetCadFileLogUseCase,
  GetCadFileUseCase,
  ListCadFilesUseCase,
} from './application/cad-queries.use-cases.js';
import {
  GetCadMappingUseCase,
  SaveCadMappingUseCase,
} from './application/cad-mapping.use-cases.js';
import { CreateDesignRevisionUseCase } from './application/create-design-revision.use-case.js';
import {
  GetDesignRevisionUseCase,
  ListDesignFeaturesUseCase,
  ListDesignRevisionsUseCase,
  ListRevisionDiffUseCase,
  ListTextLinksUseCase,
} from './application/design-revision-queries.use-cases.js';
import { DiscardDesignRevisionUseCase } from './application/discard-design-revision.use-case.js';
import type { JobQueue, ProjectEpsgLookup, TileConfig } from './application/ports.js';
import { PublishDesignRevisionUseCase } from './application/publish-design-revision.use-case.js';
import { ReprocessCadFileUseCase } from './application/reprocess-cad-file.use-case.js';
import { ReviewTextLinkUseCase } from './application/review-text-link.use-case.js';
import {
  CreateTileUrlUseCase,
  GetRevisionTilesUseCase,
  VerifyTileRequestUseCase,
} from './application/tiles.use-cases.js';
import { UploadCadFileUseCase } from './application/upload-cad-file.use-case.js';
import {
  CAD_EXTRACTION_QUERIES,
  CAD_FILE_REPOSITORY,
  CAD_MAPPING_REPOSITORY,
  CAD_MAPPING_VIEW_QUERIES,
  CAD_UNIT_OF_WORK,
  DESIGN_READ_QUERIES,
  DESIGN_REVISION_REPOSITORY,
  JOB_QUEUE,
  PROJECT_EPSG_LOOKUP,
  TILE_CONFIG,
} from './cad.tokens.js';
import type {
  CadExtractionQueries,
  CadFileRepository,
  CadUnitOfWork,
} from './domain/cad-file.repository.js';
import type {
  CadMappingRepository,
  CadMappingViewQueries,
  DesignReadQueries,
  DesignRevisionRepository,
} from './domain/design-revision.repository.js';
import { DrizzleCadExtractionQueries } from './infrastructure/drizzle-cad-extraction.queries.js';
import { DrizzleCadFileRepository } from './infrastructure/drizzle-cad-file.repository.js';
import { DrizzleCadMappingRepository } from './infrastructure/drizzle-cad-mapping.repository.js';
import { DrizzleCadUnitOfWork } from './infrastructure/drizzle-cad.unit-of-work.js';
import { DrizzleDesignReadQueries } from './infrastructure/drizzle-design-read.queries.js';
import { DrizzleDesignRevisionRepository } from './infrastructure/drizzle-design-revision.repository.js';
import { DrizzleMappingViewQueries } from './infrastructure/drizzle-mapping-view.queries.js';
import { ProjectsServiceEpsgLookup } from './infrastructure/projects-epsg-lookup.js';
import { RedisJobQueue } from './infrastructure/redis-job-queue.js';
import { CadExtractionController } from './interface/cad-extraction.controller.js';
import { CadFilesController } from './interface/cad-files.controller.js';
import { CadMappingController } from './interface/cad-mapping.controller.js';
import { DesignRevisionsController } from './interface/design-revisions.controller.js';
import { TilesVerifyController } from './interface/tiles-verify.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  {
    provide: JOB_QUEUE,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv) => new RedisJobQueue(env.REDIS_URL),
  },
  {
    provide: TILE_CONFIG,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv): TileConfig | null =>
      env.TILE_URL_SECRET && env.TILES_PUBLIC_URL
        ? { secret: env.TILE_URL_SECRET, publicUrl: env.TILES_PUBLIC_URL.replace(/\/+$/, '') }
        : null,
  },
  {
    provide: PROJECT_EPSG_LOOKUP,
    inject: [GET_PROJECT_USE_CASE],
    useFactory: (getProject: GetProjectUseCase) => new ProjectsServiceEpsgLookup(getProject),
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
    provide: CAD_MAPPING_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleCadMappingRepository(db),
  },
  {
    provide: CAD_MAPPING_VIEW_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleMappingViewQueries(db),
  },
  {
    provide: DESIGN_REVISION_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleDesignRevisionRepository(db),
  },
  {
    provide: DESIGN_READ_QUERIES,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleDesignReadQueries(db),
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
  {
    provide: GetCadMappingUseCase,
    inject: [
      CAD_FILE_REPOSITORY,
      CAD_MAPPING_REPOSITORY,
      CAD_EXTRACTION_QUERIES,
      CAD_MAPPING_VIEW_QUERIES,
      PROJECT_EPSG_LOOKUP,
    ],
    useFactory: (
      files: CadFileRepository,
      mappings: CadMappingRepository,
      extraction: CadExtractionQueries,
      view: CadMappingViewQueries,
      projects: ProjectEpsgLookup,
    ) => new GetCadMappingUseCase(files, mappings, extraction, view, projects),
  },
  {
    provide: SaveCadMappingUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new SaveCadMappingUseCase(uow, systemClock),
  },
  {
    provide: CreateDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue) =>
      new CreateDesignRevisionUseCase(uow, queue, systemClock, uuidGenerator),
  },
  {
    provide: ListDesignRevisionsUseCase,
    inject: [DESIGN_REVISION_REPOSITORY],
    useFactory: (revisions: DesignRevisionRepository) => new ListDesignRevisionsUseCase(revisions),
  },
  {
    provide: GetDesignRevisionUseCase,
    inject: [DESIGN_REVISION_REPOSITORY],
    useFactory: (revisions: DesignRevisionRepository) => new GetDesignRevisionUseCase(revisions),
  },
  {
    provide: ListDesignFeaturesUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, DESIGN_READ_QUERIES],
    useFactory: (revisions: DesignRevisionRepository, reads: DesignReadQueries) =>
      new ListDesignFeaturesUseCase(revisions, reads),
  },
  {
    provide: ListTextLinksUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, DESIGN_READ_QUERIES],
    useFactory: (revisions: DesignRevisionRepository, reads: DesignReadQueries) =>
      new ListTextLinksUseCase(revisions, reads),
  },
  {
    provide: ListRevisionDiffUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, DESIGN_READ_QUERIES],
    useFactory: (revisions: DesignRevisionRepository, reads: DesignReadQueries) =>
      new ListRevisionDiffUseCase(revisions, reads),
  },
  {
    provide: ReviewTextLinkUseCase,
    inject: [CAD_UNIT_OF_WORK, DESIGN_READ_QUERIES],
    useFactory: (uow: CadUnitOfWork, reads: DesignReadQueries) =>
      new ReviewTextLinkUseCase(uow, reads, systemClock),
  },
  {
    provide: PublishDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new PublishDesignRevisionUseCase(uow, systemClock),
  },
  {
    provide: DiscardDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) =>
      new DiscardDesignRevisionUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: GetRevisionTilesUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, OBJECT_STORAGE],
    useFactory: (revisions: DesignRevisionRepository, storage: ObjectStorage) =>
      new GetRevisionTilesUseCase(revisions, storage),
  },
  {
    provide: CreateTileUrlUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, TILE_CONFIG],
    useFactory: (revisions: DesignRevisionRepository, config: TileConfig | null) =>
      new CreateTileUrlUseCase(revisions, config, systemClock),
  },
  {
    provide: VerifyTileRequestUseCase,
    inject: [TILE_CONFIG],
    useFactory: (config: TileConfig | null) => new VerifyTileRequestUseCase(config, systemClock),
  },
];

@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [
    CadFilesController,
    CadExtractionController,
    CadMappingController,
    DesignRevisionsController,
    TilesVerifyController,
  ],
  providers,
})
export class CadModule implements OnApplicationShutdown {
  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.queue instanceof RedisJobQueue) await this.queue.close();
  }
}
