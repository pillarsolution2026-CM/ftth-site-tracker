import { AppError } from '../../../common/app-error.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import type { Contract } from '../domain/contract.js';
import type {
  ContractAttachment,
  ContractAttachmentRepository,
  ContractRepository,
  ContractSummaryRow,
  ContractTx,
} from '../domain/contract.repository.js';

export interface ContractView {
  contract: Contract;
  attachments: ContractAttachment[];
  projectCount: number;
}

/** Reads the contract with its attachments inside a transaction (after a write). */
export async function viewInTx(tx: ContractTx, contractId: string): Promise<ContractView> {
  const contract = await tx.contracts.findById(contractId);
  if (!contract) throw new AppError('NOT_FOUND', 'Contract not found');
  return {
    contract,
    attachments: await tx.attachments.listByContract(contractId),
    projectCount: await tx.contracts.projectCount(contractId),
  };
}

export class ListContractsUseCase {
  constructor(private readonly contracts: ContractRepository) {}

  execute(): Promise<ContractSummaryRow[]> {
    return this.contracts.list();
  }
}

export class GetContractUseCase {
  constructor(
    private readonly contracts: ContractRepository,
    private readonly attachments: ContractAttachmentRepository,
  ) {}

  async execute(contractId: string): Promise<ContractView> {
    const contract = await this.contracts.findById(contractId);
    if (!contract) throw new AppError('NOT_FOUND', 'Contract not found');
    return {
      contract,
      attachments: await this.attachments.listByContract(contractId),
      projectCount: await this.contracts.projectCount(contractId),
    };
  }
}

/** The contract of a project (read by PMs). 404 when the project predates Phase 2. */
export class GetProjectContractUseCase {
  constructor(
    private readonly projects: Pick<GetProjectUseCase, 'execute'>,
    private readonly contracts: GetContractUseCase,
  ) {}

  async execute(projectId: string): Promise<ContractView> {
    const project = await this.projects.execute(projectId);
    if (!project.contractId) throw new AppError('NOT_FOUND', 'The project has no contract');
    return this.contracts.execute(project.contractId);
  }
}
