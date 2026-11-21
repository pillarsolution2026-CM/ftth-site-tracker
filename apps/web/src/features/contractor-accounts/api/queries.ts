import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateContractorAccountInput } from '@ftth/shared';
import {
  createContractorAccount,
  listContractorAccounts,
  setContractorAccountActive,
} from './accounts-api';

export const contractorAccountsKey = (projectId: string, registrationId: string) =>
  ['contractor-accounts', projectId, registrationId] as const;

export function useContractorAccounts(projectId: string, registrationId: string) {
  return useQuery({
    queryKey: contractorAccountsKey(projectId, registrationId),
    queryFn: () => listContractorAccounts(projectId, registrationId),
    retry: false,
  });
}

export function useCreateContractorAccount(projectId: string, registrationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateContractorAccountInput) =>
      createContractorAccount(projectId, registrationId, body),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: contractorAccountsKey(projectId, registrationId) }),
  });
}

export function useSetContractorAccountActive(projectId: string, registrationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; isActive: boolean }) =>
      setContractorAccountActive(projectId, registrationId, input.userId, input.isActive),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: contractorAccountsKey(projectId, registrationId) }),
  });
}
