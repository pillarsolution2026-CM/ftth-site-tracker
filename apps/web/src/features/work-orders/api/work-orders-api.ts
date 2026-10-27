import {
  AddWorkOrderItemRequestSchema,
  CreateWorkOrderRequestSchema,
  UpdateWorkOrderItemRequestSchema,
  UpdateWorkOrderRequestSchema,
  WorkOrderAttachmentSchema,
  WorkOrderDetailSchema,
  WorkOrderItemSchema,
  WorkOrderListResponseSchema,
  type WorkOrderAttachment,
  type WorkOrderDetail,
  type WorkOrderItem,
  type WorkOrderListResponse,
} from '@ftth/shared';
import type { z } from 'zod';
import {
  bffJson,
  bffUpload,
  bffVoid,
  projectApiPath,
  type UploadOptions,
} from '@/shared/api/bff-client';

export type CreateInput = z.input<typeof CreateWorkOrderRequestSchema>;
export type UpdateInput = z.input<typeof UpdateWorkOrderRequestSchema>;
export type AddItemInput = z.input<typeof AddWorkOrderItemRequestSchema>;
export type UpdateItemInput = z.input<typeof UpdateWorkOrderItemRequestSchema>;

const root = (projectId: string) => projectApiPath(projectId, '/work-orders');
const one = (projectId: string, id: string) => `${root(projectId)}/${encodeURIComponent(id)}`;

export function listWorkOrders(projectId: string): Promise<WorkOrderListResponse> {
  return bffJson(root(projectId), WorkOrderListResponseSchema);
}

export function getWorkOrder(projectId: string, id: string): Promise<WorkOrderDetail> {
  return bffJson(one(projectId, id), WorkOrderDetailSchema);
}

export function createWorkOrder(projectId: string, body: CreateInput): Promise<WorkOrderDetail> {
  return bffJson(root(projectId), WorkOrderDetailSchema, {
    method: 'POST',
    body: CreateWorkOrderRequestSchema.parse(body),
  });
}

export function updateWorkOrder(
  projectId: string,
  id: string,
  body: UpdateInput,
): Promise<WorkOrderDetail> {
  return bffJson(one(projectId, id), WorkOrderDetailSchema, {
    method: 'PATCH',
    body: UpdateWorkOrderRequestSchema.parse(body),
  });
}

export function deleteWorkOrder(projectId: string, id: string): Promise<void> {
  return bffVoid(one(projectId, id), { method: 'DELETE' });
}

export function addItem(
  projectId: string,
  workOrderId: string,
  body: AddItemInput,
): Promise<WorkOrderItem> {
  return bffJson(`${one(projectId, workOrderId)}/items`, WorkOrderItemSchema, {
    method: 'POST',
    body: AddWorkOrderItemRequestSchema.parse(body),
  });
}

export function updateItem(
  projectId: string,
  workOrderId: string,
  itemId: string,
  body: UpdateItemInput,
): Promise<WorkOrderItem> {
  return bffJson(
    `${one(projectId, workOrderId)}/items/${encodeURIComponent(itemId)}`,
    WorkOrderItemSchema,
    { method: 'PATCH', body: UpdateWorkOrderItemRequestSchema.parse(body) },
  );
}

export function deleteItem(projectId: string, workOrderId: string, itemId: string): Promise<void> {
  return bffVoid(`${one(projectId, workOrderId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
  });
}

export function uploadAttachment(
  projectId: string,
  workOrderId: string,
  file: File,
  options?: UploadOptions,
): Promise<WorkOrderAttachment> {
  const form = new FormData();
  form.append('file', file);
  return bffUpload(
    `${one(projectId, workOrderId)}/attachments`,
    form,
    WorkOrderAttachmentSchema,
    options,
  );
}

export function deleteAttachment(
  projectId: string,
  workOrderId: string,
  attachmentId: string,
): Promise<void> {
  return bffVoid(`${one(projectId, workOrderId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  });
}

/** Plain link: the browser downloads it with its session cookie via the proxy. */
export function attachmentContentUrl(
  projectId: string,
  workOrderId: string,
  attachmentId: string,
): string {
  return `${one(projectId, workOrderId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}
