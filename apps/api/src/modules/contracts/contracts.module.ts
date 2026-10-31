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
import { ProjectsModule } from '../projects/projects.module.js';
import { GET_PROJECT_USE_CASE } from '../projects/projects.tokens.js';
import type { WorkbookReader } from '../work-orders/application/ports.js';
import { ExcelJsWorkbookReader } from '../work-orders/infrastructure/exceljs-workbook-reader.js';
import {
  AddContractAttachmentUseCase,
  DeleteContractAttachmentUseCase,
  GetContractAttachmentContentUseCase,
} from './application/attachment.use-cases.js';
import {
  GetContractUseCase,
  GetProjectContractUseCase,
  ListContractsUseCase,
} from './application/contract-queries.js';
import {
  AddContractItemUseCase,
  ApproveContractUseCase,
  CreateContractUseCase,
  RemoveContractItemUseCase,
  UpdateContractItemUseCase,
  UpdateContractUseCase,
} from './application/contract.use-cases.js';
import {
  CommitContractImportUseCase,
  PreviewContractImportUseCase,
} from './application/import.use-cases.js';
import type {
  ContractAttachmentRepository,
  ContractRepository,
  ContractUnitOfWork,
} from './domain/contract.repository.js';
import {
  CONTRACT_ATTACHMENT_REPOSITORY,
  CONTRACT_REPOSITORY,
  CONTRACT_UNIT_OF_WORK,
  CONTRACT_WORKBOOK_READER,
} from './contracts.tokens.js';
import { DrizzleContractAttachmentRepository } from './infrastructure/drizzle-contract-attachment.repository.js';
import { DrizzleContractRepository } from './infrastructure/drizzle-contract.repository.js';
import { DrizzleContractUnitOfWork } from './infrastructure/drizzle-contract.unit-of-work.js';
import { AdminContractAttachmentsController } from './interface/admin-contract-attachments.controller.js';
import { AdminContractImportController } from './interface/admin-contract-import.controller.js';
import { AdminContractsController } from './interface/admin-contracts.controller.js';
import { ProjectContractController } from './interface/project-contract.controller.js';

const providers: Provider[] = [
  PermissionGuard,
  {
    provide: CONTRACT_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractRepository(db),
  },
  {
    provide: CONTRACT_ATTACHMENT_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractAttachmentRepository(db),
  },
  {
    provide: CONTRACT_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractUnitOfWork(db),
  },
  { provide: CONTRACT_WORKBOOK_READER, useValue: new ExcelJsWorkbookReader() },
  {
    provide: ListContractsUseCase,
    inject: [CONTRACT_REPOSITORY],
    useFactory: (contracts: ContractRepository) => new ListContractsUseCase(contracts),
  },
  {
    provide: GetContractUseCase,
    inject: [CONTRACT_REPOSITORY, CONTRACT_ATTACHMENT_REPOSITORY],
    useFactory: (contracts: ContractRepository, attachments: ContractAttachmentRepository) =>
      new GetContractUseCase(contracts, attachments),
  },
  {
    provide: GetProjectContractUseCase,
    inject: [GET_PROJECT_USE_CASE, GetContractUseCase],
    useFactory: (projects: GetProjectUseCase, contract: GetContractUseCase) =>
      new GetProjectContractUseCase(projects, contract),
  },
  {
    provide: CreateContractUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) =>
      new CreateContractUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: UpdateContractUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) => new UpdateContractUseCase(uow),
  },
  {
    provide: AddContractItemUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) =>
      new AddContractItemUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: UpdateContractItemUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) => new UpdateContractItemUseCase(uow, systemClock),
  },
  {
    provide: RemoveContractItemUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) => new RemoveContractItemUseCase(uow),
  },
  {
    provide: ApproveContractUseCase,
    inject: [CONTRACT_UNIT_OF_WORK],
    useFactory: (uow: ContractUnitOfWork) => new ApproveContractUseCase(uow, systemClock),
  },
  {
    provide: PreviewContractImportUseCase,
    inject: [CONTRACT_REPOSITORY, CONTRACT_WORKBOOK_READER],
    useFactory: (contracts: ContractRepository, reader: WorkbookReader) =>
      new PreviewContractImportUseCase(contracts, reader),
  },
  {
    provide: CommitContractImportUseCase,
    inject: [CONTRACT_WORKBOOK_READER, CONTRACT_UNIT_OF_WORK, CONTRACT_REPOSITORY, OBJECT_STORAGE],
    useFactory: (
      reader: WorkbookReader,
      uow: ContractUnitOfWork,
      contracts: ContractRepository,
      storage: ObjectStorage,
    ) =>
      new CommitContractImportUseCase(reader, uow, contracts, storage, systemClock, uuidGenerator),
  },
  {
    provide: AddContractAttachmentUseCase,
    inject: [CONTRACT_UNIT_OF_WORK, CONTRACT_REPOSITORY, OBJECT_STORAGE, APP_ENV],
    useFactory: (
      uow: ContractUnitOfWork,
      contracts: ContractRepository,
      storage: ObjectStorage,
      env: ApiEnv,
    ) =>
      new AddContractAttachmentUseCase(
        uow,
        contracts,
        storage,
        systemClock,
        uuidGenerator,
        maxUploadBytes(env.MAX_UPLOAD_MB),
      ),
  },
  {
    provide: GetContractAttachmentContentUseCase,
    inject: [CONTRACT_ATTACHMENT_REPOSITORY, OBJECT_STORAGE],
    useFactory: (attachments: ContractAttachmentRepository, storage: ObjectStorage) =>
      new GetContractAttachmentContentUseCase(attachments, storage),
  },
  {
    provide: DeleteContractAttachmentUseCase,
    inject: [CONTRACT_UNIT_OF_WORK, OBJECT_STORAGE],
    useFactory: (uow: ContractUnitOfWork, storage: ObjectStorage) =>
      new DeleteContractAttachmentUseCase(uow, storage),
  },
];

@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [
    AdminContractsController,
    AdminContractImportController,
    AdminContractAttachmentsController,
    ProjectContractController,
  ],
  providers,
})
export class ContractsModule {}
