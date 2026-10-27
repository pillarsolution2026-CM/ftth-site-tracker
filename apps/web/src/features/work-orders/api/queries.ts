import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AddItemInput,
  type CreateInput,
  type UpdateInput,
  type UpdateItemInput,
  addItem,
  createWorkOrder,
  deleteAttachment,
  deleteItem,
  deleteWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateItem,
  updateWorkOrder,
  uploadAttachment,
} from './work-orders-api';

export const workOrdersKey = (projectId: string) => ['work-orders', projectId] as const;
export const workOrderKey = (projectId: string, id: string) =>
  ['work-order', projectId, id] as const;

export function useWorkOrders(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: workOrdersKey(projectId),
    queryFn: () => listWorkOrders(projectId),
    retry: false,
  });
}

export function useWorkOrder(projectId: string, id: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: workOrderKey(projectId, id),
    queryFn: () => getWorkOrder(projectId, id),
    retry: false,
  });
}

/** Detail, list and totals depend on each other: refresh both after any change. */
function useInvalidateWorkOrder(projectId: string, workOrderId?: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: workOrdersKey(projectId) }),
      workOrderId
        ? client.invalidateQueries({ queryKey: workOrderKey(projectId, workOrderId) })
        : Promise.resolve(),
    ]);
}

export function useCreateWorkOrder(projectId: string) {
  const invalidate = useInvalidateWorkOrder(projectId);
  return useMutation({
    mutationFn: (body: CreateInput) => createWorkOrder(projectId, body),
    onSuccess: invalidate,
  });
}

export function useUpdateWorkOrder(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (body: UpdateInput) => updateWorkOrder(projectId, workOrderId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteWorkOrder(projectId: string, workOrderId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteWorkOrder(projectId, workOrderId),
    onSuccess: async () => {
      client.removeQueries({ queryKey: workOrderKey(projectId, workOrderId) });
      await client.invalidateQueries({ queryKey: workOrdersKey(projectId) });
    },
  });
}

export function useAddItem(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (body: AddItemInput) => addItem(projectId, workOrderId, body),
    onSuccess: invalidate,
  });
}

export function useUpdateItem(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (input: { itemId: string; body: UpdateItemInput }) =>
      updateItem(projectId, workOrderId, input.itemId, input.body),
    onSuccess: invalidate,
  });
}

export function useDeleteItem(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(projectId, workOrderId, itemId),
    onSuccess: invalidate,
  });
}

export function useUploadAttachment(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (input: { file: File; onProgress?: (fraction: number) => void }) =>
      uploadAttachment(projectId, workOrderId, input.file, {
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteAttachment(projectId: string, workOrderId: string) {
  const invalidate = useInvalidateWorkOrder(projectId, workOrderId);
  return useMutation({
    mutationFn: (attachmentId: string) => deleteAttachment(projectId, workOrderId, attachmentId),
    onSuccess: invalidate,
  });
}
