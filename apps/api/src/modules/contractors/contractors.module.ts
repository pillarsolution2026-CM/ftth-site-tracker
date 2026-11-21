import { Module, type Provider } from '@nestjs/common';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/object-storage.port.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { DB, type Database } from '../../db/db.module.js';
import type { WorkbookReader } from '../work-orders/application/ports.js';
import { ExcelJsWorkbookReader } from '../work-orders/infrastructure/exceljs-workbook-reader.js';
import { IdentityModule } from '../identity/identity.module.js';
import { Argon2PasswordHasher } from '../identity/infrastructure/argon2-password-hasher.js';
import type { GetProjectUseCase } from '../projects/application/get-project.use-case.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { GET_PROJECT_USE_CASE } from '../projects/projects.tokens.js';
import {
  GetContractorUseCase,
  GetProjectContractorsUseCase,
  ListContractorsUseCase,
} from './application/contractor-queries.js';
import {
  CreateContractorUseCase,
  UpdateContractorUseCase,
} from './application/contractor.use-cases.js';
import {
  CreateContractorAccountUseCase,
  ListContractorAccountsUseCase,
  SetContractorAccountActiveUseCase,
} from './application/contractor-account.use-cases.js';
import { GetContractorPortalUseCase } from './application/contractor-portal.use-case.js';
import {
  CommitContractorImportUseCase,
  PreviewContractorImportUseCase,
} from './application/import.use-cases.js';
import {
  AddContractorPriceUseCase,
  RemoveContractorLineUseCase,
  RemoveRegistrationUseCase,
  UpdateContractorLineUseCase,
} from './application/registration.use-cases.js';
import type {
  ContractorAccountRepository,
  ContractorAccountUnitOfWork,
  ContractorPortalRepository,
} from './domain/contractor-account.js';
import type {
  ContractorRepository,
  ContractorUnitOfWork,
  RegistrationRepository,
} from './domain/contractor.repository.js';
import {
  CONTRACTOR_ACCOUNT_REPOSITORY,
  CONTRACTOR_ACCOUNT_UNIT_OF_WORK,
  CONTRACTOR_PORTAL_REPOSITORY,
  CONTRACTOR_REPOSITORY,
  CONTRACTOR_UNIT_OF_WORK,
  CONTRACTOR_WORKBOOK_READER,
  REGISTRATION_REPOSITORY,
} from './contractors.tokens.js';
import {
  DrizzleContractorAccountRepository,
  DrizzleContractorAccountUnitOfWork,
} from './infrastructure/drizzle-contractor-account.repository.js';
import { DrizzleContractorPortalRepository } from './infrastructure/drizzle-contractor-portal.repository.js';
import { DrizzleContractorRepository } from './infrastructure/drizzle-contractor.repository.js';
import { DrizzleContractorUnitOfWork } from './infrastructure/drizzle-contractor.unit-of-work.js';
import { DrizzleRegistrationRepository } from './infrastructure/drizzle-registration.repository.js';
import { ContractorAccountsController } from './interface/contractor-accounts.controller.js';
import { ContractorPortalController } from './interface/contractor-portal.controller.js';
import { ContractorAccountGuard } from './interface/contractor-portal.guard.js';
import { AdminContractorImportController } from './interface/admin-contractor-import.controller.js';
import { AdminContractorsController } from './interface/admin-contractors.controller.js';
import { AdminProjectContractorsController } from './interface/admin-project-contractors.controller.js';
import { ProjectContractorsController } from './interface/project-contractors.controller.js';

const withProjectsAndUow = [GET_PROJECT_USE_CASE, CONTRACTOR_UNIT_OF_WORK];

const providers: Provider[] = [
  PermissionGuard,
  ContractorAccountGuard,
  {
    provide: CONTRACTOR_ACCOUNT_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractorAccountRepository(db),
  },
  {
    provide: CONTRACTOR_ACCOUNT_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractorAccountUnitOfWork(db),
  },
  {
    provide: CONTRACTOR_PORTAL_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractorPortalRepository(db),
  },
  {
    provide: ListContractorAccountsUseCase,
    inject: [CONTRACTOR_ACCOUNT_REPOSITORY],
    useFactory: (accounts: ContractorAccountRepository) =>
      new ListContractorAccountsUseCase(accounts),
  },
  {
    provide: CreateContractorAccountUseCase,
    inject: [CONTRACTOR_ACCOUNT_REPOSITORY, CONTRACTOR_ACCOUNT_UNIT_OF_WORK],
    useFactory: (accounts: ContractorAccountRepository, uow: ContractorAccountUnitOfWork) =>
      new CreateContractorAccountUseCase(accounts, uow, new Argon2PasswordHasher()),
  },
  {
    provide: SetContractorAccountActiveUseCase,
    inject: [CONTRACTOR_ACCOUNT_REPOSITORY, CONTRACTOR_ACCOUNT_UNIT_OF_WORK],
    useFactory: (accounts: ContractorAccountRepository, uow: ContractorAccountUnitOfWork) =>
      new SetContractorAccountActiveUseCase(accounts, uow, systemClock),
  },
  {
    provide: GetContractorPortalUseCase,
    inject: [CONTRACTOR_PORTAL_REPOSITORY],
    useFactory: (portal: ContractorPortalRepository) =>
      new GetContractorPortalUseCase(portal, systemClock),
  },
  {
    provide: CONTRACTOR_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractorRepository(db),
  },
  {
    provide: REGISTRATION_REPOSITORY,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleRegistrationRepository(db),
  },
  {
    provide: CONTRACTOR_UNIT_OF_WORK,
    inject: [DB],
    useFactory: (db: Database) => new DrizzleContractorUnitOfWork(db),
  },
  { provide: CONTRACTOR_WORKBOOK_READER, useValue: new ExcelJsWorkbookReader() },
  {
    provide: PreviewContractorImportUseCase,
    inject: [
      GET_PROJECT_USE_CASE,
      REGISTRATION_REPOSITORY,
      CONTRACTOR_REPOSITORY,
      CONTRACTOR_WORKBOOK_READER,
    ],
    useFactory: (
      projects: GetProjectUseCase,
      registrations: RegistrationRepository,
      contractors: ContractorRepository,
      reader: WorkbookReader,
    ) => new PreviewContractorImportUseCase(projects, registrations, contractors, reader),
  },
  {
    provide: CommitContractorImportUseCase,
    inject: [
      GET_PROJECT_USE_CASE,
      CONTRACTOR_WORKBOOK_READER,
      CONTRACTOR_UNIT_OF_WORK,
      REGISTRATION_REPOSITORY,
      CONTRACTOR_REPOSITORY,
      OBJECT_STORAGE,
    ],
    useFactory: (
      projects: GetProjectUseCase,
      reader: WorkbookReader,
      uow: ContractorUnitOfWork,
      registrations: RegistrationRepository,
      contractors: ContractorRepository,
      storage: ObjectStorage,
    ) =>
      new CommitContractorImportUseCase(
        projects,
        reader,
        uow,
        registrations,
        contractors,
        storage,
        uuidGenerator,
      ),
  },
  {
    provide: ListContractorsUseCase,
    inject: [CONTRACTOR_REPOSITORY],
    useFactory: (contractors: ContractorRepository) => new ListContractorsUseCase(contractors),
  },
  {
    provide: GetContractorUseCase,
    inject: [CONTRACTOR_REPOSITORY],
    useFactory: (contractors: ContractorRepository) => new GetContractorUseCase(contractors),
  },
  {
    provide: GetProjectContractorsUseCase,
    inject: [GET_PROJECT_USE_CASE, REGISTRATION_REPOSITORY],
    useFactory: (projects: GetProjectUseCase, registrations: RegistrationRepository) =>
      new GetProjectContractorsUseCase(projects, registrations),
  },
  {
    provide: CreateContractorUseCase,
    inject: [CONTRACTOR_UNIT_OF_WORK],
    useFactory: (uow: ContractorUnitOfWork) =>
      new CreateContractorUseCase(uow, systemClock, uuidGenerator),
  },
  {
    provide: UpdateContractorUseCase,
    inject: [CONTRACTOR_UNIT_OF_WORK],
    useFactory: (uow: ContractorUnitOfWork) => new UpdateContractorUseCase(uow),
  },
  {
    provide: RemoveRegistrationUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new RemoveRegistrationUseCase(projects, uow),
  },
  {
    provide: UpdateContractorLineUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new UpdateContractorLineUseCase(projects, uow),
  },
  {
    provide: RemoveContractorLineUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new RemoveContractorLineUseCase(projects, uow),
  },
  {
    provide: AddContractorPriceUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new AddContractorPriceUseCase(projects, uow, uuidGenerator),
  },
];

@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [
    AdminContractorsController,
    AdminContractorImportController,
    AdminProjectContractorsController,
    ProjectContractorsController,
    ContractorAccountsController,
    ContractorPortalController,
  ],
  providers,
})
export class ContractorsModule {}
