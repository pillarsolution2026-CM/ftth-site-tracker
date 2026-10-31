import { Module, type Provider } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { maxUploadBytes } from '../../common/http/multipart-payload.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { APP_ENV } from '../../config/config.module.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import type { GetProjectUseCase } from '../projects/application/get-project.use-case.js';
import { GET_PROJECT_USE_CASE } from '../projects/projects.tokens.js';
import { ProjectsModule } from '../projects/projects.module.js';
import {
  AddAttachmentUseCase,
  DeleteAttachmentUseCase,
  GetAttachmentContentUseCase,
  ListAttachmentsUseCase,
} from './application/attachment.use-cases.js';
import { CreateWorkOrderUseCase } from './application/create-work-order.use-case.js';
import { DeleteWorkOrderUseCase } from './application/delete-work-order.use-case.js';
import {
  CommitImportUseCase,
  PreviewWorkOrderImportUseCase,
} from './application/import.use-cases.js';
import type { ProjectCurrencyLookup, WorkbookReader } from './application/ports.js';
import { UpdateWorkOrderUseCase } from './application/update-work-order.use-case.js';
import {
  AddWorkOrderItemUseCase,
  RemoveWorkOrderItemUseCase,
  UpdateWorkOrderItemUseCase,
} from './application/work-order-item.use-cases.js';
import {
  GetWorkOrderUseCase,
  ListContractItemAvailabilityUseCase,
  ListWorkOrdersUseCase,
} from './application/work-order-queries.js';
import type {
  ContractCatalog,
  WorkOrderAttachmentRepository,
  WorkOrderRepository,
  WorkOrderUnitOfWork,
} from './domain/work-order.repository.js';
import { DrizzleContractCatalog } from './infrastructure/drizzle-contract-catalog.js';
import { DrizzleWorkOrderAttachmentRepository } from './infrastructure/drizzle-work-order-attachment.repository.js';
import { DrizzleWorkOrderRepository } from './infrastructure/drizzle-work-order.repository.js';
import { DrizzleWorkOrderUnitOfWork } from './infrastructure/drizzle-work-order.unit-of-work.js';
import { ExcelJsWorkbookReader } from './infrastructure/exceljs-workbook-reader.js';
import { ProjectsServiceCurrencyLookup } from './infrastructure/projects-currency-lookup.js';
import { WorkOrderAttachmentsController } from './interface/work-order-attachments.controller.js';
import { WorkOrderImportController } from './interface/work-order-import.controller.js';
import { WorkOrdersController } from './interface/work-orders.controller.js';
import {
  ATTACHMENT_REPOSITORY,
  CONTRACT_CATALOG,
  PROJECT_CURRENCY_LOOKUP,
  WORK_ORDER_REPOSITORY,
  WORK_ORDER_UNIT_OF_WORK,
  WORKBOOK_READER,
} from './work-orders.tokens.js';

const providers: Provider[] = [
  PermissionGuard,
  {
    provide: WORK_ORDER_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleWorkOrderRepository(db),
  },
  {
    provide: ATTACHMENT_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleWorkOrderAttachmentRepository(db),
  },
  {
    provide: WORK_ORDER_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleWorkOrderUnitOfWork(db),
  },
  {
    provide: PROJECT_CURRENCY_LOOKUP,
    inject: [GET_PROJECT_USE_CASE],
    useFactory: (getProject: GetProjectUseCase) => new ProjectsServiceCurrencyLookup(getProject),
  },
  {
    provide: CONTRACT_CATALOG,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractCatalog(db),
  },
  { provide: WORKBOOK_READER, useValue: new ExcelJsWorkbookReader() },
  {
    provide: ListContractItemAvailabilityUseCase,
    inject: [CONTRACT_CATALOG, WORK_ORDER_REPOSITORY],
    useFactory: (contracts: ContractCatalog, orders: WorkOrderRepository) =>
      new ListContractItemAvailabilityUseCase(contracts, orders),
  },
  {
    provide: ListWorkOrdersUseCase,
    inject: [WORK_ORDER_REPOSITORY],
    useFactory: (orders: WorkOrderRepository) => new ListWorkOrdersUseCase(orders),
  },
  {
    provide: GetWorkOrderUseCase,
    inject: [WORK_ORDER_REPOSITORY, ATTACHMENT_REPOSITORY],
    useFactory: (orders: WorkOrderRepository, attachments: WorkOrderAttachmentRepository) =>
      new GetWorkOrderUseCase(orders, attachments),
  },
  {
    provide: CreateWorkOrderUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK, PROJECT_CURRENCY_LOOKUP],
    useFactory: (uow: WorkOrderUnitOfWork, projects: ProjectCurrencyLookup) =>
      new CreateWorkOrderUseCase(uow, projects, systemClock, uuidGenerator),
  },
  {
    provide: UpdateWorkOrderUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK],
    useFactory: (uow: WorkOrderUnitOfWork) => new UpdateWorkOrderUseCase(uow),
  },
  {
    provide: DeleteWorkOrderUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK, OBJECT_STORAGE],
    useFactory: (uow: WorkOrderUnitOfWork, storage: ObjectStorage) =>
      new DeleteWorkOrderUseCase(uow, storage),
  },
  {
    provide: AddWorkOrderItemUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK],
    useFactory: (uow: WorkOrderUnitOfWork) =>
      new AddWorkOrderItemUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: UpdateWorkOrderItemUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK],
    useFactory: (uow: WorkOrderUnitOfWork) => new UpdateWorkOrderItemUseCase(uow, systemClock),
  },
  {
    provide: RemoveWorkOrderItemUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK],
    useFactory: (uow: WorkOrderUnitOfWork) => new RemoveWorkOrderItemUseCase(uow),
  },
  {
    provide: ListAttachmentsUseCase,
    inject: [WORK_ORDER_REPOSITORY, ATTACHMENT_REPOSITORY],
    useFactory: (orders: WorkOrderRepository, attachments: WorkOrderAttachmentRepository) =>
      new ListAttachmentsUseCase(orders, attachments),
  },
  {
    provide: AddAttachmentUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK, WORK_ORDER_REPOSITORY, OBJECT_STORAGE, APP_ENV],
    useFactory: (
      uow: WorkOrderUnitOfWork,
      orders: WorkOrderRepository,
      storage: ObjectStorage,
      env: ApiEnv,
    ) =>
      new AddAttachmentUseCase(
        uow,
        orders,
        storage,
        systemClock,
        uuidGenerator,
        maxUploadBytes(env.MAX_UPLOAD_MB),
      ),
  },
  {
    provide: GetAttachmentContentUseCase,
    inject: [ATTACHMENT_REPOSITORY, OBJECT_STORAGE],
    useFactory: (attachments: WorkOrderAttachmentRepository, storage: ObjectStorage) =>
      new GetAttachmentContentUseCase(attachments, storage),
  },
  {
    provide: DeleteAttachmentUseCase,
    inject: [WORK_ORDER_UNIT_OF_WORK, OBJECT_STORAGE],
    useFactory: (uow: WorkOrderUnitOfWork, storage: ObjectStorage) =>
      new DeleteAttachmentUseCase(uow, storage),
  },
  {
    provide: PreviewWorkOrderImportUseCase,
    inject: [WORKBOOK_READER, CONTRACT_CATALOG, WORK_ORDER_REPOSITORY],
    useFactory: (reader: WorkbookReader, contracts: ContractCatalog, orders: WorkOrderRepository) =>
      new PreviewWorkOrderImportUseCase(reader, contracts, orders),
  },
  {
    provide: CommitImportUseCase,
    inject: [
      WORKBOOK_READER,
      WORK_ORDER_UNIT_OF_WORK,
      CONTRACT_CATALOG,
      WORK_ORDER_REPOSITORY,
      PROJECT_CURRENCY_LOOKUP,
      OBJECT_STORAGE,
    ],
    useFactory: (
      reader: WorkbookReader,
      uow: WorkOrderUnitOfWork,
      contracts: ContractCatalog,
      orders: WorkOrderRepository,
      projects: ProjectCurrencyLookup,
      storage: ObjectStorage,
    ) =>
      new CommitImportUseCase(
        reader,
        uow,
        contracts,
        orders,
        projects,
        storage,
        systemClock,
        uuidGenerator,
      ),
  },
];

@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [WorkOrdersController, WorkOrderImportController, WorkOrderAttachmentsController],
  providers,
})
export class WorkOrdersModule {}
