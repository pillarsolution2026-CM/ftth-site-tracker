import {
  ContractorAccountListResponseSchema,
  ContractorAccountSchema,
  CreateContractorAccountRequestSchema,
  UpdateContractorAccountRequestSchema,
  type ContractorAccount,
  type ContractorAccountListResponse,
  type CreateContractorAccountInput,
} from '@ftth/shared';
import { bffJson } from '@/shared/api/bff-client';

const enc = encodeURIComponent;
/** Platform-admin routes (ADR-053): through the admin BFF. */
const accountsPath = (projectId: string, registrationId: string) =>
  `/api/admin/projects/${enc(projectId)}/contractors/${enc(registrationId)}/accounts`;

export function listContractorAccounts(
  projectId: string,
  registrationId: string,
): Promise<ContractorAccountListResponse> {
  return bffJson(accountsPath(projectId, registrationId), ContractorAccountListResponseSchema);
}

export function createContractorAccount(
  projectId: string,
  registrationId: string,
  body: CreateContractorAccountInput,
): Promise<ContractorAccount> {
  return bffJson(accountsPath(projectId, registrationId), ContractorAccountSchema, {
    method: 'POST',
    body: CreateContractorAccountRequestSchema.parse(body),
  });
}

export function setContractorAccountActive(
  projectId: string,
  registrationId: string,
  userId: string,
  isActive: boolean,
): Promise<ContractorAccount> {
  return bffJson(
    `${accountsPath(projectId, registrationId)}/${enc(userId)}`,
    ContractorAccountSchema,
    { method: 'PATCH', body: UpdateContractorAccountRequestSchema.parse({ isActive }) },
  );
}
