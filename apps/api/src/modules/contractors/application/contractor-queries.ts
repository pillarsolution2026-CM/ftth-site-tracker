import { AppError } from '../../../common/app-error.js';
import type { Decimal } from '../../work-orders/domain/decimal.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import {
  reservedOf,
  type ContractorSummary,
  type Registration,
  type WorkOrderLine,
} from '../domain/contractor.js';
import type {
  ContractorRepository,
  RegistrationRepository,
} from '../domain/contractor.repository.js';

/** What is left of one work-order line for contractors. */
export interface AvailabilityRow {
  item: WorkOrderLine;
  /** Σ quantity of every contractor line on the work-order line. */
  reserved: Decimal;
  available: Decimal;
}

export interface ProjectContractorsView {
  projectId: string;
  workOrderId: string | null;
  currency: string;
  registrations: Registration[];
  availability: AvailabilityRow[];
}

/** Reads the project's contractors and availability; works on a transaction's repository too. */
export async function viewOf(
  registrations: RegistrationRepository,
  projectId: string,
  currency: string,
): Promise<ProjectContractorsView> {
  const workOrderId = await registrations.workOrderOf(projectId);
  if (workOrderId === null) {
    return { projectId, workOrderId, currency, registrations: [], availability: [] };
  }
  const [lines, reserved, list] = await Promise.all([
    registrations.workOrderLines(workOrderId),
    registrations.reservedByLine(workOrderId),
    registrations.list(projectId),
  ]);
  return {
    projectId,
    workOrderId,
    currency,
    registrations: list,
    availability: lines.map((item) => {
      const held = reservedOf(reserved, item.id);
      return { item, reserved: held, available: item.quantity.sub(held) };
    }),
  };
}

export class ListContractorsUseCase {
  constructor(private readonly contractors: ContractorRepository) {}

  execute(): Promise<ContractorSummary[]> {
    return this.contractors.list();
  }
}

export class GetContractorUseCase {
  constructor(private readonly contractors: ContractorRepository) {}

  async execute(contractorId: string): Promise<ContractorSummary> {
    const contractor = await this.contractors.findById(contractorId);
    if (!contractor) throw new AppError('NOT_FOUND', 'Contractor not found');
    return contractor;
  }
}

/** Contractors of a project (admin and PM reads). 404 when the project does not exist. */
export class GetProjectContractorsUseCase {
  constructor(
    private readonly projects: Pick<GetProjectUseCase, 'execute'>,
    private readonly registrations: RegistrationRepository,
  ) {}

  async execute(projectId: string): Promise<ProjectContractorsView> {
    const project = await this.projects.execute(projectId);
    return viewOf(this.registrations, projectId, project.currency);
  }
}
