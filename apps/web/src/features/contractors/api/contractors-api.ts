import {
  AddContractorPriceRequestSchema,
  ContractorListResponseSchema,
  CreateContractorRequestSchema,
  ProjectContractorsResponseSchema,
  RegisterContractorRequestSchema,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
  type ContractorListResponse,
  type ProjectContractorsResponse,
} from '@ftth/shared';
import { z } from 'zod';
import { bffJson, bffVoid, projectApiPath } from '@/shared/api/bff-client';

export type CreateContractorInput = z.input<typeof CreateContractorRequestSchema>;
export type UpdateContractorInput = z.input<typeof UpdateContractorRequestSchema>;
export type RegisterContractorInput = z.input<typeof RegisterContractorRequestSchema>;
export type UpdateContractorLineInput = z.input<typeof UpdateContractorLineRequestSchema>;
export type AddContractorPriceInput = z.input<typeof AddContractorPriceRequestSchema>;

/**
 * The write routes' response bodies are not fixed by the shared contract, and the screens refetch
 * the project's registrations after every write, so the body is accepted as is.
 */
const ANY_BODY = z.unknown();

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

export async function createContractor(body: CreateContractorInput): Promise<void> {
  await bffJson(`${ADMIN}/contractors`, ANY_BODY, {
    method: 'POST',
    body: CreateContractorRequestSchema.parse(body),
  });
}

export async function updateContractor(
  contractorId: string,
  body: UpdateContractorInput,
): Promise<void> {
  await bffJson(`${ADMIN}/contractors/${enc(contractorId)}`, ANY_BODY, {
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

export async function registerContractor(
  projectId: string,
  body: RegisterContractorInput,
): Promise<void> {
  await bffJson(registrationsPath(projectId), ANY_BODY, {
    method: 'POST',
    body: RegisterContractorRequestSchema.parse(body),
  });
}

export function removeRegistration(projectId: string, registrationId: string): Promise<void> {
  return bffVoid(registrationPath(projectId, registrationId), { method: 'DELETE' });
}

export async function updateContractorLine(
  projectId: string,
  registrationId: string,
  lineId: string,
  body: UpdateContractorLineInput,
): Promise<void> {
  await bffJson(linePath(projectId, registrationId, lineId), ANY_BODY, {
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

export async function addContractorPrice(
  projectId: string,
  registrationId: string,
  lineId: string,
  body: AddContractorPriceInput,
): Promise<void> {
  await bffJson(`${linePath(projectId, registrationId, lineId)}/prices`, ANY_BODY, {
    method: 'POST',
    body: AddContractorPriceRequestSchema.parse(body),
  });
}
