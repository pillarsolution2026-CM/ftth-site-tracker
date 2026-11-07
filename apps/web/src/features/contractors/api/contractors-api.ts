import {
  AddContractorPriceRequestSchema,
  AddContractorLineRequestSchema,
  ContractorListResponseSchema,
  ContractorSchema,
  CreateContractorRequestSchema,
  ProjectContractorsResponseSchema,
  RegisterContractorRequestSchema,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
  type Contractor,
  type ContractorListResponse,
  type ProjectContractorsResponse,
} from '@ftth/shared';
import type { z } from 'zod';
import { bffJson, bffVoid, projectApiPath } from '@/shared/api/bff-client';

export type CreateContractorInput = z.input<typeof CreateContractorRequestSchema>;
export type UpdateContractorInput = z.input<typeof UpdateContractorRequestSchema>;
export type RegisterContractorInput = z.input<typeof RegisterContractorRequestSchema>;
export type UpdateContractorLineInput = z.input<typeof UpdateContractorLineRequestSchema>;
export type AddContractorLineInput = z.input<typeof AddContractorLineRequestSchema>;
export type AddContractorPriceInput = z.input<typeof AddContractorPriceRequestSchema>;

const ADMIN = '/api/admin';
const enc = encodeURIComponent;
const registrationsPath = (projectId: string) => `${ADMIN}/projects/${enc(projectId)}/contractors`;
const registrationPath = (projectId: string, registrationId: string) =>
  `${registrationsPath(projectId)}/${enc(registrationId)}`;
const linePath = (projectId: string, registrationId: string, lineId: string) =>
  `${registrationPath(projectId, registrationId)}/lines/${enc(lineId)}`;

// ---------- shared list ----------

export function listContractors(): Promise<ContractorListResponse> {
  return bffJson(`${ADMIN}/contractors`, ContractorListResponseSchema);
}

export function createContractor(body: CreateContractorInput): Promise<Contractor> {
  return bffJson(`${ADMIN}/contractors`, ContractorSchema, {
    method: 'POST',
    body: CreateContractorRequestSchema.parse(body),
  });
}

export function updateContractor(
  contractorId: string,
  body: UpdateContractorInput,
): Promise<Contractor> {
  return bffJson(`${ADMIN}/contractors/${enc(contractorId)}`, ContractorSchema, {
    method: 'PATCH',
    body: UpdateContractorRequestSchema.parse(body),
  });
}

// ---------- on a project ----------

/** Admin view: registrations plus what is left of each work-order line. */
export function getAdminProjectContractors(projectId: string): Promise<ProjectContractorsResponse> {
  return bffJson(registrationsPath(projectId), ProjectContractorsResponseSchema);
}

/** PM view (`contractors:read`). */
export function getProjectContractors(projectId: string): Promise<ProjectContractorsResponse> {
  return bffJson(projectApiPath(projectId, '/contractors'), ProjectContractorsResponseSchema);
}

export function registerContractor(
  projectId: string,
  body: RegisterContractorInput,
): Promise<ProjectContractorsResponse> {
  return bffJson(registrationsPath(projectId), ProjectContractorsResponseSchema, {
    method: 'POST',
    body: RegisterContractorRequestSchema.parse(body),
  });
}

export function removeRegistration(projectId: string, registrationId: string): Promise<void> {
  return bffVoid(registrationPath(projectId, registrationId), { method: 'DELETE' });
}

export function updateContractorLine(
  projectId: string,
  registrationId: string,
  lineId: string,
  body: UpdateContractorLineInput,
): Promise<ProjectContractorsResponse> {
  return bffJson(linePath(projectId, registrationId, lineId), ProjectContractorsResponseSchema, {
    method: 'PATCH',
    body: UpdateContractorLineRequestSchema.parse(body),
  });
}

export function removeContractorLine(
  projectId: string,
  registrationId: string,
  lineId: string,
): Promise<void> {
  return bffVoid(linePath(projectId, registrationId, lineId), { method: 'DELETE' });
}

export function addContractorPrice(
  projectId: string,
  registrationId: string,
  lineId: string,
  body: AddContractorPriceInput,
): Promise<ProjectContractorsResponse> {
  return bffJson(
    `${linePath(projectId, registrationId, lineId)}/prices`,
    ProjectContractorsResponseSchema,
    {
      method: 'POST',
      body: AddContractorPriceRequestSchema.parse(body),
    },
  );
}

export function addContractorLine(
  projectId: string,
  registrationId: string,
  body: AddContractorLineInput,
): Promise<ProjectContractorsResponse> {
  return bffJson(
    `${registrationPath(projectId, registrationId)}/lines`,
    ProjectContractorsResponseSchema,
    {
      method: 'POST',
      body: AddContractorLineRequestSchema.parse(body),
    },
  );
}
