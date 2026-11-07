import { AppError } from '../../../common/app-error.js';
import { sumDecimals, type Decimal } from '../../work-orders/domain/decimal.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import type {
  ContractorSummary,
  Registration,
  ScopeHolding,
  WorkOrderLine,
} from '../domain/contractor.js';
import type {
  ContractorRepository,
  RegistrationRepository,
} from '../domain/contractor.repository.js';

/** One scope of a work-order line across every contractor. */
export interface ScopeUsage {
  scope: string | null;
  reserved: Decimal;
  available: Decimal;
  highestPrice: Decimal;
}

/** What is left of one work-order line for contractors. */
export interface AvailabilityRow {
  item: WorkOrderLine;
  mode: 'free' | 'whole' | 'scoped';
  scopes: ScopeUsage[];
  /** Σ highest price over the scopes. */
  scopesPriceTotal: Decimal;
  /** contract price − scopesPriceTotal. */
  priceRoom: Decimal;
}

export interface ProjectContractorsView {
  projectId: string;
  workOrderId: string | null;
  currency: string;
  registrations: Registration[];
  availability: AvailabilityRow[];
}

export function availabilityOf(
  item: WorkOrderLine,
  holdings: readonly ScopeHolding[],
): AvailabilityRow {
  const own = holdings.filter((holding) => holding.workOrderItemId === item.id);
  const scopes = own.map((holding) => ({
    scope: holding.scope,
    reserved: holding.quantity,
    available: item.quantity.sub(holding.quantity),
    highestPrice: holding.highestPrice,
  }));
  const total = sumDecimals(scopes.map((scope) => scope.highestPrice));
  return {
    item,
    mode:
      own.length === 0
        ? 'free'
        : own.some((holding) => holding.scopeKey === null)
          ? 'whole'
          : 'scoped',
    scopes,
    scopesPriceTotal: total,
    priceRoom: item.unitPrice.sub(total),
  };
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
  const [lines, holdings, list] = await Promise.all([
    registrations.workOrderLines(workOrderId),
    registrations.holdings(workOrderId),
    registrations.list(projectId),
  ]);
  return {
    projectId,
    workOrderId,
    currency,
    registrations: list,
    availability: lines.map((item) => availabilityOf(item, holdings)),
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
