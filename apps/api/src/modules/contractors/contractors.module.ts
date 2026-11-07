import { Module, type Provider } from '@nestjs/common';
import { systemClock, uuidGenerator } from '../../common/clock.js';
import { PermissionGuard } from '../../common/permission.guard.js';
import { DB, type Database } from '../../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
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
  AddContractorLineUseCase,
  AddContractorPriceUseCase,
  RegisterContractorUseCase,
  RemoveContractorLineUseCase,
  RemoveRegistrationUseCase,
  UpdateContractorLineUseCase,
} from './application/registration.use-cases.js';
import type {
  ContractorRepository,
  ContractorUnitOfWork,
  RegistrationRepository,
} from './domain/contractor.repository.js';
import {
  CONTRACTOR_REPOSITORY,
  CONTRACTOR_UNIT_OF_WORK,
  REGISTRATION_REPOSITORY,
} from './contractors.tokens.js';
import { DrizzleContractorRepository } from './infrastructure/drizzle-contractor.repository.js';
import { DrizzleContractorUnitOfWork } from './infrastructure/drizzle-contractor.unit-of-work.js';
import { DrizzleRegistrationRepository } from './infrastructure/drizzle-registration.repository.js';
import { AdminContractorsController } from './interface/admin-contractors.controller.js';
import { AdminProjectContractorsController } from './interface/admin-project-contractors.controller.js';
import { ProjectContractorsController } from './interface/project-contractors.controller.js';

const withProjectsAndUow = [GET_PROJECT_USE_CASE, CONTRACTOR_UNIT_OF_WORK];

const providers: Provider[] = [
  PermissionGuard,
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
    provide: RegisterContractorUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new RegisterContractorUseCase(projects, uow, uuidGenerator),
  },
  {
    provide: RemoveRegistrationUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new RemoveRegistrationUseCase(projects, uow),
  },
  {
    provide: AddContractorLineUseCase,
    inject: withProjectsAndUow,
    useFactory: (projects: GetProjectUseCase, uow: ContractorUnitOfWork) =>
      new AddContractorLineUseCase(projects, uow, uuidGenerator),
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
    AdminProjectContractorsController,
    ProjectContractorsController,
  ],
  providers,
})
export class ContractorsModule {}
