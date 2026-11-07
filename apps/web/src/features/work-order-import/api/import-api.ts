import {
  ContractDetailSchema,
  ContractorImportCommitPayloadSchema,
  ContractorImportPreviewOptionsSchema,
  ContractorImportPreviewResponseSchema,
  ProjectContractorsResponseSchema,
  ContractImportCommitPayloadSchema,
  ContractImportPreviewOptionsSchema,
  ContractImportPreviewResponseSchema,
  WorkOrderDetailSchema,
  WorkOrderImportCommitPayloadSchema,
  WorkOrderImportPreviewOptionsSchema,
  WorkOrderImportPreviewResponseSchema,
  type ContractDetail,
  type ContractorImportPreviewOptions,
  type ProjectContractorsResponse,
  type WorkOrderDetail,
  type WorkOrderImportPreviewOptions,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import type { z } from 'zod';
import { bffUpload, projectApiPath, type UploadOptions } from '@/shared/api/bff-client';

const importPath = (projectId: string) => projectApiPath(projectId, '/work-orders/import');

function multipart(file: File, payload: unknown): FormData {
  const form = new FormData();
  // `payload` first so the server can validate it before it reads the file stream.
  form.append('payload', JSON.stringify(payload));
  form.append('file', file);
  return form;
}

/** No writes: parses the sheet and returns rows, issues and a suggested mapping. */
export function previewImport(
  projectId: string,
  file: File,
  options: WorkOrderImportPreviewOptions,
  upload?: UploadOptions,
): Promise<WorkOrderImportPreviewResponse> {
  return bffUpload(
    `${importPath(projectId)}/preview`,
    multipart(file, WorkOrderImportPreviewOptionsSchema.parse(options)),
    WorkOrderImportPreviewResponseSchema,
    upload,
  );
}

/** Creates the work order. The server re-parses the file; a changed file fails with IMPORT_INVALID. */
export function commitImport(
  projectId: string,
  file: File,
  payload: z.input<typeof WorkOrderImportCommitPayloadSchema>,
  upload?: UploadOptions,
): Promise<WorkOrderDetail> {
  return bffUpload(
    importPath(projectId),
    multipart(file, WorkOrderImportCommitPayloadSchema.parse(payload)),
    WorkOrderDetailSchema,
    upload,
  );
}

const contractImportPath = (contractId: string) =>
  `/api/admin/contracts/${encodeURIComponent(contractId)}/import`;

/** Contract BOQ import, step 1: same parsing as the work-order import, no writes. */
export function previewContractImport(
  contractId: string,
  file: File,
  options: WorkOrderImportPreviewOptions,
  upload?: UploadOptions,
): Promise<WorkOrderImportPreviewResponse> {
  return bffUpload(
    `${contractImportPath(contractId)}/preview`,
    multipart(file, ContractImportPreviewOptionsSchema.parse(options)),
    ContractImportPreviewResponseSchema,
    upload,
  );
}

/** Replaces every line of the draft contract with the included rows. */
export function commitContractImport(
  contractId: string,
  file: File,
  payload: z.input<typeof ContractImportCommitPayloadSchema>,
  upload?: UploadOptions,
): Promise<ContractDetail> {
  return bffUpload(
    contractImportPath(contractId),
    multipart(file, ContractImportCommitPayloadSchema.parse(payload)),
    ContractDetailSchema,
    upload,
  );
}

const contractorImportPath = (projectId: string) =>
  `/api/admin/projects/${encodeURIComponent(projectId)}/contractors/import`;

/** Contractor sheet (ADR-036), step 1: checks every row against the work order; no writes. */
export function previewContractorImport(
  projectId: string,
  file: File,
  options: ContractorImportPreviewOptions,
  upload?: UploadOptions,
): Promise<WorkOrderImportPreviewResponse> {
  return bffUpload(
    `${contractorImportPath(projectId)}/preview`,
    multipart(file, ContractorImportPreviewOptionsSchema.parse(options)),
    ContractorImportPreviewResponseSchema,
    upload,
  );
}

/** Registers the contractor (or appends lines); answers the project's contractors. */
export function commitContractorImport(
  projectId: string,
  file: File,
  payload: z.input<typeof ContractorImportCommitPayloadSchema>,
  upload?: UploadOptions,
): Promise<ProjectContractorsResponse> {
  return bffUpload(
    contractorImportPath(projectId),
    multipart(file, ContractorImportCommitPayloadSchema.parse(payload)),
    ProjectContractorsResponseSchema,
    upload,
  );
}
