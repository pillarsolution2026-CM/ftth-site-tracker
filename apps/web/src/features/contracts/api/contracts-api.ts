import {
  AddContractItemRequestSchema,
  ApproveContractRequestSchema,
  ContractAttachmentSchema,
  ContractDetailSchema,
  ContractListResponseSchema,
  CreateContractRequestSchema,
  UpdateContractItemRequestSchema,
  UpdateContractRequestSchema,
  type ContractAttachment,
  type ContractDetail,
  type ContractListResponse,
} from '@ftth/shared';
import type { z } from 'zod';
import {
  bffJson,
  bffUpload,
  bffVoid,
  projectApiPath,
  type UploadOptions,
} from '@/shared/api/bff-client';

export type CreateContractInput = z.input<typeof CreateContractRequestSchema>;
export type UpdateContractInput = z.input<typeof UpdateContractRequestSchema>;
export type AddContractItemInput = z.input<typeof AddContractItemRequestSchema>;
export type UpdateContractItemInput = z.input<typeof UpdateContractItemRequestSchema>;

/** Platform-admin endpoints through the BFF (`/api/admin/contracts/...`). */
const ROOT = '/api/admin/contracts';
const one = (contractId: string) => `${ROOT}/${encodeURIComponent(contractId)}`;

export function listContracts(): Promise<ContractListResponse> {
  return bffJson(ROOT, ContractListResponseSchema);
}

export function getContract(contractId: string): Promise<ContractDetail> {
  return bffJson(one(contractId), ContractDetailSchema);
}

/** Read-only contract of a project (`contract:read`); 404 when the project has no contract. */
export function getProjectContract(projectId: string): Promise<ContractDetail> {
  return bffJson(projectApiPath(projectId, '/contract'), ContractDetailSchema);
}

export function createContract(body: CreateContractInput): Promise<ContractDetail> {
  return bffJson(ROOT, ContractDetailSchema, {
    method: 'POST',
    body: CreateContractRequestSchema.parse(body),
  });
}

export function updateContract(
  contractId: string,
  body: UpdateContractInput,
): Promise<ContractDetail> {
  return bffJson(one(contractId), ContractDetailSchema, {
    method: 'PATCH',
    body: UpdateContractRequestSchema.parse(body),
  });
}

export function addContractItem(
  contractId: string,
  body: AddContractItemInput,
): Promise<ContractDetail> {
  return bffJson(`${one(contractId)}/items`, ContractDetailSchema, {
    method: 'POST',
    body: AddContractItemRequestSchema.parse(body),
  });
}

export function updateContractItem(
  contractId: string,
  itemId: string,
  body: UpdateContractItemInput,
): Promise<ContractDetail> {
  return bffJson(`${one(contractId)}/items/${encodeURIComponent(itemId)}`, ContractDetailSchema, {
    method: 'PATCH',
    body: UpdateContractItemRequestSchema.parse(body),
  });
}

export function removeContractItem(
  contractId: string,
  itemId: string,
  expectedVersion: number,
): Promise<ContractDetail> {
  return bffJson(
    `${one(contractId)}/items/${encodeURIComponent(itemId)}?expectedVersion=${expectedVersion}`,
    ContractDetailSchema,
    { method: 'DELETE' },
  );
}

export function approveContract(
  contractId: string,
  expectedVersion: number,
): Promise<ContractDetail> {
  return bffJson(`${one(contractId)}/approve`, ContractDetailSchema, {
    method: 'POST',
    body: ApproveContractRequestSchema.parse({ expectedVersion }),
  });
}

export function uploadContractAttachment(
  contractId: string,
  file: File,
  upload?: UploadOptions,
): Promise<ContractAttachment> {
  const form = new FormData();
  form.append('file', file);
  return bffUpload(`${one(contractId)}/attachments`, form, ContractAttachmentSchema, upload);
}

export function deleteContractAttachment(contractId: string, attachmentId: string): Promise<void> {
  return bffVoid(`${one(contractId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  });
}

export function contractAttachmentUrl(contractId: string, attachmentId: string): string {
  return `${one(contractId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
