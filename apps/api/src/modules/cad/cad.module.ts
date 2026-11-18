import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { drawingFlowFromEnv, type ApiEnv, type DrawingFlow } from '@ftth/shared';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { maxUploadBytes } from '../../common/http/multipart-payload.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { FixedWindowRateLimiter } from '../identity/application/fixed-window-rate-limiter.js';
import { IdentityModule } from '../identity/identity.module.js';
import type { GetProjectUseCase } from '../projects/application/get-project.use-case.js';
import { ProjectsModule } from '../projects/projects.module.js';
import type { FindWorkOrderLinesUseCase } from '../work-orders/application/work-order-lines.js';
import { FIND_WORK_ORDER_LINES, FIND_WORK_ORDER_SITES } from '../work-orders/work-orders.tokens.js';
import type { FindWorkOrderSitesUseCase } from '../work-orders/application/work-order-sites-port.js';
import { WorkOrdersServiceSites } from './infrastructure/work-orders-service-sites.js';
import { SiteDrawingsController } from './interface/site-drawings.controller.js';
import {
  AssignDrawingSiteUseCase,
  ListSiteDrawingsUseCase,
  WithdrawSiteDrawingUseCase,
} from './application/site-drawings.use-cases.js';
import { WorkOrdersModule } from '../work-orders/work-orders.module.js';
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
  GetPlacementDrawingUseCase,
  SaveCadMappingUseCase,
} from './application/cad-mapping.use-cases.js';
import {
  GetDrawingViewContentUseCase,
  GetDrawingViewStateUseCase,
  RequestDrawingViewUseCase,
} from './application/drawing-view.use-cases.js';
import { CreateDesignRevisionUseCase } from './application/create-design-revision.use-case.js';
import {
  GetDesignRevisionUseCase,
  ListDesignFeaturesUseCase,
  ListDesignRevisionsUseCase,
  ListRevisionDiffUseCase,
  ListTextLinksUseCase,
} from './application/design-revision-queries.use-cases.js';
import { DiscardDesignRevisionUseCase } from './application/discard-design-revision.use-case.js';
import { RebuildDesignRevisionUseCase } from './application/rebuild-design-revision.use-case.js';
import {
  CreateDrawingCorrectionUseCase,
  ListDrawingCorrectionsUseCase,
  WithdrawDrawingCorrectionUseCase,
} from './application/drawing-correction.use-cases.js';
import { DrawingCorrectionsController } from './interface/drawing-corrections.controller.js';
import {
  AddTrenchMarkUseCase,
  GetInstallationUseCase,
  GetRevisionInstallationUseCase,
  SetInstallationAnswerUseCase,
  WithdrawTrenchMarkUseCase,
} from './application/installation.use-cases.js';
import { GetSecondaryPlacementSuggestionUseCase } from './application/secondary-placement.use-case.js';
import { InstallationController } from './interface/installation.controller.js';
import { SecondaryPlacementController } from './interface/secondary-placement.controller.js';
import {
  GetBoxTypeStateUseCase,
  GetRevisionBoxTypesUseCase,
  SetBoxTypesUseCase,
} from './application/box-types.use-cases.js';
import { BoxTypesController } from './interface/box-types.controller.js';
import { WorkOrdersServiceLines } from './infrastructure/work-orders-service-lines.js';
import type {
  JobQueue,
  ProjectEpsgLookup,
  TileConfig,
  WorkOrderLines,
  WorkOrderSites,
} from './application/ports.js';
import {
  GetPublishReadinessUseCase,
  GetSitePublishReadinessUseCase,
  PublishDesignRevisionUseCase,
} from './application/publish-design-revision.use-case.js';
import { ReprocessCadFileUseCase } from './application/reprocess-cad-file.use-case.js';
import { ReviewTextLinkUseCase } from './application/review-text-link.use-case.js';
import { ListDrawingProblemsUseCase } from './application/drawing-problems.use-cases.js';
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
  DRAWING_VIEW_RATE_BUDGET,
  DRAWING_VIEW_RATE_LIMITER,
  DRAWING_PROBLEM_REPOSITORY,
  GPS_PROPOSAL_REPOSITORY,
  JOB_QUEUE,
  PROJECT_EPSG_LOOKUP,
  WORK_ORDER_LINES,
  WORK_ORDER_SITES,
  DRAWING_FLOW,
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
  DrawingProblemRepository,
} from './domain/design-revision.repository.js';
import { DrizzleCadExtractionQueries } from './infrastructure/drizzle-cad-extraction.queries.js';
import { DrizzleCadFileRepository } from './infrastructure/drizzle-cad-file.repository.js';
import { DrizzleCadMappingRepository } from './infrastructure/drizzle-cad-mapping.repository.js';
import { DrizzleCadUnitOfWork } from './infrastructure/drizzle-cad.unit-of-work.js';
import { DrizzleDesignReadQueries } from './infrastructure/drizzle-design-read.queries.js';
import { DrizzleDrawingProblemRepository } from './infrastructure/drizzle-drawing-problem.repository.js';
import { DrizzleDesignRevisionRepository } from './infrastructure/drizzle-design-revision.repository.js';
import { DrizzleGpsProposalRepository } from './infrastructure/drizzle-gps-proposal.repository.js';
import { DrizzleMappingViewQueries } from './infrastructure/drizzle-mapping-view.queries.js';
import {
  AcceptGpsProposalUseCase,
  GetGpsProposalPhotoUseCase,
  ListGpsProposalsUseCase,
  RejectGpsProposalUseCase,
} from './application/gps-proposal.use-cases.js';
import type { GpsProposalRepository } from './domain/gps-proposal.js';
import { GpsProposalsController } from './interface/gps-proposals.controller.js';
import { ProjectsServiceEpsgLookup } from './infrastructure/projects-epsg-lookup.js';
import { RedisJobQueue } from './infrastructure/redis-job-queue.js';
import { CadExtractionController } from './interface/cad-extraction.controller.js';
import { CadFilesController } from './interface/cad-files.controller.js';
import { CadMappingController } from './interface/cad-mapping.controller.js';
import { DesignRevisionsController } from './interface/design-revisions.controller.js';
import { DrawingViewRateLimitGuard } from './interface/drawing-view-rate-limit.guard.js';
import { DrawingViewController } from './interface/drawing-view.controller.js';
import { TilesVerifyController } from './interface/tiles-verify.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  DrawingViewRateLimitGuard,
  {
    provide: DRAWING_VIEW_RATE_LIMITER,
    useFactory: () => new FixedWindowRateLimiter(systemClock, 10 * 60_000),
  },
  { provide: DRAWING_VIEW_RATE_BUDGET, useValue: 10 },
  {
    provide: DRAWING_FLOW,
    inject: [APP_ENV],
    useFactory: (env: ApiEnv): DrawingFlow => drawingFlowFromEnv(env),
  },
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
    provide: WORK_ORDER_LINES,
    inject: [FIND_WORK_ORDER_LINES],
    useFactory: (find: FindWorkOrderLinesUseCase) => new WorkOrdersServiceLines(find),
  },
  {
    provide: WORK_ORDER_SITES,
    inject: [FIND_WORK_ORDER_SITES],
    useFactory: (find: FindWorkOrderSitesUseCase) => new WorkOrdersServiceSites(find),
  },
  {
    provide: ListSiteDrawingsUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_SITES],
    useFactory: (uow: CadUnitOfWork, sites: WorkOrderSites) =>
      new ListSiteDrawingsUseCase(uow, sites),
  },
  {
    provide: AssignDrawingSiteUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_SITES],
    useFactory: (uow: CadUnitOfWork, sites: WorkOrderSites) =>
      new AssignDrawingSiteUseCase(uow, sites),
  },
  {
    provide: WithdrawSiteDrawingUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) =>
      new WithdrawSiteDrawingUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: GetSitePublishReadinessUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_LINES, WORK_ORDER_SITES, DRAWING_FLOW],
    useFactory: (
      uow: CadUnitOfWork,
      lines: WorkOrderLines,
      sites: WorkOrderSites,
      flow: DrawingFlow,
    ) => new GetSitePublishReadinessUseCase(uow, lines, sites, flow),
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
    provide: DRAWING_PROBLEM_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleDrawingProblemRepository(db),
  },
  {
    provide: GPS_PROPOSAL_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleGpsProposalRepository(db),
  },
  {
    provide: ListGpsProposalsUseCase,
    inject: [GPS_PROPOSAL_REPOSITORY],
    useFactory: (proposals: GpsProposalRepository) => new ListGpsProposalsUseCase(proposals),
  },
  {
    provide: GetGpsProposalPhotoUseCase,
    inject: [GPS_PROPOSAL_REPOSITORY, OBJECT_STORAGE],
    useFactory: (proposals: GpsProposalRepository, storage: ObjectStorage) =>
      new GetGpsProposalPhotoUseCase(proposals, storage),
  },
  {
    provide: AcceptGpsProposalUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new AcceptGpsProposalUseCase(uow, systemClock),
  },
  {
    provide: RejectGpsProposalUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new RejectGpsProposalUseCase(uow, systemClock),
  },
  {
    provide: CAD_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleCadUnitOfWork(db),
  },
  {
    provide: UploadCadFileUseCase,
    inject: [CAD_UNIT_OF_WORK, OBJECT_STORAGE, JOB_QUEUE, APP_ENV, WORK_ORDER_SITES],
    useFactory: (
      uow: CadUnitOfWork,
      storage: ObjectStorage,
      queue: JobQueue,
      env: ApiEnv,
      sites: WorkOrderSites,
    ) =>
      new UploadCadFileUseCase(
        uow,
        storage,
        queue,
        systemClock,
        uuidGenerator,
        maxUploadBytes(env.MAX_UPLOAD_MB),
        sites,
      ),
  },
  {
    provide: ReprocessCadFileUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue) =>
      new ReprocessCadFileUseCase(uow, queue, systemClock, uuidGenerator),
  },
  {
    provide: GetDrawingViewStateUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new GetDrawingViewStateUseCase(uow),
  },
  {
    provide: RequestDrawingViewUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue) =>
      new RequestDrawingViewUseCase(uow, queue, systemClock, uuidGenerator),
  },
  {
    provide: GetDrawingViewContentUseCase,
    inject: [CAD_UNIT_OF_WORK, OBJECT_STORAGE],
    useFactory: (uow: CadUnitOfWork, storage: ObjectStorage) =>
      new GetDrawingViewContentUseCase(uow, storage),
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
    provide: GetPlacementDrawingUseCase,
    inject: [CAD_FILE_REPOSITORY, CAD_MAPPING_VIEW_QUERIES],
    useFactory: (files: CadFileRepository, view: CadMappingViewQueries) =>
      new GetPlacementDrawingUseCase(files, view),
  },
  {
    provide: SaveCadMappingUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new SaveCadMappingUseCase(uow, systemClock),
  },
  {
    provide: CreateDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE, WORK_ORDER_LINES, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue, lines: WorkOrderLines, flow: DrawingFlow) =>
      new CreateDesignRevisionUseCase(uow, queue, systemClock, uuidGenerator, lines, flow),
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
    provide: ListDrawingProblemsUseCase,
    inject: [DESIGN_REVISION_REPOSITORY, DRAWING_PROBLEM_REPOSITORY],
    useFactory: (revisions: DesignRevisionRepository, problems: DrawingProblemRepository) =>
      new ListDrawingProblemsUseCase(revisions, problems),
  },
  {
    provide: GetPublishReadinessUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_LINES, WORK_ORDER_SITES, DRAWING_FLOW],
    useFactory: (
      uow: CadUnitOfWork,
      lines: WorkOrderLines,
      sites: WorkOrderSites,
      flow: DrawingFlow,
    ) => new GetPublishReadinessUseCase(uow, lines, sites, flow),
  },
  {
    provide: PublishDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_LINES, WORK_ORDER_SITES, DRAWING_FLOW],
    useFactory: (
      uow: CadUnitOfWork,
      lines: WorkOrderLines,
      sites: WorkOrderSites,
      flow: DrawingFlow,
    ) => new PublishDesignRevisionUseCase(uow, systemClock, lines, sites, flow),
  },
  {
    provide: DiscardDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) =>
      new DiscardDesignRevisionUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: RebuildDesignRevisionUseCase,
    inject: [CAD_UNIT_OF_WORK, JOB_QUEUE, WORK_ORDER_LINES, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, queue: JobQueue, lines: WorkOrderLines, flow: DrawingFlow) =>
      new RebuildDesignRevisionUseCase(uow, queue, systemClock, uuidGenerator, lines, flow),
  },
  {
    provide: ListDrawingCorrectionsUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new ListDrawingCorrectionsUseCase(uow),
  },
  {
    provide: CreateDrawingCorrectionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) =>
      new CreateDrawingCorrectionUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: WithdrawDrawingCorrectionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new WithdrawDrawingCorrectionUseCase(uow, systemClock),
  },
  {
    provide: GetInstallationUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) => new GetInstallationUseCase(uow, flow),
  },
  {
    provide: SetInstallationAnswerUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) =>
      new SetInstallationAnswerUseCase(uow, systemClock, uuidGenerator, flow),
  },
  {
    provide: AddTrenchMarkUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) =>
      new AddTrenchMarkUseCase(uow, systemClock, uuidGenerator, flow),
  },
  {
    provide: WithdrawTrenchMarkUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) =>
      new WithdrawTrenchMarkUseCase(uow, systemClock, flow),
  },
  {
    provide: GetRevisionInstallationUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) =>
      new GetRevisionInstallationUseCase(uow, flow),
  },
  {
    provide: GetBoxTypeStateUseCase,
    inject: [CAD_UNIT_OF_WORK, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, flow: DrawingFlow) => new GetBoxTypeStateUseCase(uow, flow),
  },
  {
    provide: SetBoxTypesUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_LINES, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, lines: WorkOrderLines, flow: DrawingFlow) =>
      new SetBoxTypesUseCase(uow, lines, systemClock, uuidGenerator, flow),
  },
  {
    provide: GetRevisionBoxTypesUseCase,
    inject: [CAD_UNIT_OF_WORK, WORK_ORDER_LINES, DRAWING_FLOW],
    useFactory: (uow: CadUnitOfWork, lines: WorkOrderLines, flow: DrawingFlow) =>
      new GetRevisionBoxTypesUseCase(uow, lines, flow),
  },
  {
    provide: GetSecondaryPlacementSuggestionUseCase,
    inject: [CAD_UNIT_OF_WORK],
    useFactory: (uow: CadUnitOfWork) => new GetSecondaryPlacementSuggestionUseCase(uow),
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
  imports: [IdentityModule, ProjectsModule, WorkOrdersModule],
  controllers: [
    CadFilesController,
    SiteDrawingsController,
    CadExtractionController,
    CadMappingController,
    DrawingCorrectionsController,
    InstallationController,
    BoxTypesController,
    SecondaryPlacementController,
    DrawingViewController,
    GpsProposalsController,
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
