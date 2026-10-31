import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContractDetail } from '@ftth/shared';
import {
  addContractItem,
  approveContract,
  createContract,
  deleteContractAttachment,
  getContract,
  getProjectContract,
  listContracts,
  removeContractItem,
  updateContract,
  updateContractItem,
  uploadContractAttachment,
  type AddContractItemInput,
  type CreateContractInput,
  type UpdateContractInput,
  type UpdateContractItemInput,
} from './contracts-api';

export const contractsKey = ['admin', 'contracts'] as const;
export const contractKey = (contractId: string) => ['admin', 'contract', contractId] as const;
export const projectContractKey = (projectId: string) => ['project-contract', projectId] as const;

export function useContracts(enabled = true) {
  return useQuery({ enabled, queryKey: contractsKey, queryFn: listContracts, retry: false });
}

export function useContract(contractId: string | null) {
  return useQuery({
    enabled: contractId !== null,
    queryKey: contractKey(contractId ?? ''),
    queryFn: () => getContract(contractId ?? ''),
    retry: false,
  });
}

export function useProjectContract(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: projectContractKey(projectId),
    queryFn: () => getProjectContract(projectId),
    retry: false,
  });
}

/** Every write answers with the new detail: store it, and refresh the list (counts, totals). */
function useStoreDetail() {
  const client = useQueryClient();
  return async (detail: ContractDetail) => {
    client.setQueryData(contractKey(detail.id), detail);
    await client.invalidateQueries({ queryKey: contractsKey });
  };
}

export function useCreateContract() {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: CreateContractInput) => createContract(body),
    onSuccess: store,
  });
}

export function useUpdateContract(contractId: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: UpdateContractInput) => updateContract(contractId, body),
    onSuccess: store,
  });
}

export function useAddContractItem(contractId: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: AddContractItemInput) => addContractItem(contractId, body),
    onSuccess: store,
  });
}

export function useUpdateContractItem(contractId: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (input: { itemId: string; body: UpdateContractItemInput }) =>
      updateContractItem(contractId, input.itemId, input.body),
    onSuccess: store,
  });
}

export function useRemoveContractItem(contractId: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (input: { itemId: string; expectedVersion: number }) =>
      removeContractItem(contractId, input.itemId, input.expectedVersion),
    onSuccess: store,
  });
}

export function useApproveContract(contractId: string) {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (expectedVersion: number) => approveContract(contractId, expectedVersion),
    onSuccess: store,
  });
}

export function useUploadContractAttachment(contractId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: File; onProgress?: (fraction: number) => void }) =>
      uploadContractAttachment(contractId, input.file, {
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: contractKey(contractId) }),
  });
}

export function useDeleteContractAttachment(contractId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) => deleteContractAttachment(contractId, attachmentId),
    onSuccess: () => client.invalidateQueries({ queryKey: contractKey(contractId) }),
  });
}
