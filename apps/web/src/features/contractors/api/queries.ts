import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addContractorPrice,
  createContractor,
  getAdminProjectContractors,
  getProjectContractors,
  listContractors,
  registerContractor,
  removeContractorLine,
  removeRegistration,
  updateContractor,
  updateContractorLine,
  type AddContractorPriceInput,
  type CreateContractorInput,
  type RegisterContractorInput,
  type UpdateContractorInput,
  type UpdateContractorLineInput,
} from './contractors-api';

export const contractorsKey = ['admin', 'contractors'] as const;
export const adminProjectContractorsKey = (projectId: string) =>
  ['admin', 'project-contractors', projectId] as const;
export const projectContractorsKey = (projectId: string) =>
  ['project-contractors', projectId] as const;

export function useContractors(enabled = true) {
  return useQuery({ enabled, queryKey: contractorsKey, queryFn: listContractors, retry: false });
}

export function useAdminProjectContractors(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: adminProjectContractorsKey(projectId),
    queryFn: () => getAdminProjectContractors(projectId),
    retry: false,
  });
}

export function useProjectContractors(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: projectContractorsKey(projectId),
    queryFn: () => getProjectContractors(projectId),
    retry: false,
  });
}

export function useCreateContractor() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateContractorInput) => createContractor(body),
    onSuccess: () => client.invalidateQueries({ queryKey: contractorsKey }),
  });
}

export function useUpdateContractor() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractorId: string; body: UpdateContractorInput }) =>
      updateContractor(input.contractorId, input.body),
    // Registrations show the contractor's contact details.
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin'] }),
  });
}

/** Every registration write changes the project's registrations, availability and the counts. */
function useRefreshProject(projectId: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: adminProjectContractorsKey(projectId) }),
      client.invalidateQueries({ queryKey: projectContractorsKey(projectId) }),
      client.invalidateQueries({ queryKey: contractorsKey }),
    ]);
}

export function useRegisterContractor(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (body: RegisterContractorInput) => registerContractor(projectId, body),
    onSuccess: refresh,
  });
}

export function useRemoveRegistration(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (registrationId: string) => removeRegistration(projectId, registrationId),
    onSuccess: refresh,
  });
}

export function useUpdateContractorLine(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (input: {
      registrationId: string;
      lineId: string;
      body: UpdateContractorLineInput;
    }) => updateContractorLine(projectId, input.registrationId, input.lineId, input.body),
    onSuccess: refresh,
  });
}

export function useRemoveContractorLine(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (input: { registrationId: string; lineId: string }) =>
      removeContractorLine(projectId, input.registrationId, input.lineId),
    onSuccess: refresh,
  });
}

export function useAddContractorPrice(projectId: string) {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (input: {
      registrationId: string;
      lineId: string;
      body: AddContractorPriceInput;
    }) => addContractorPrice(projectId, input.registrationId, input.lineId, input.body),
    onSuccess: refresh,
  });
}
