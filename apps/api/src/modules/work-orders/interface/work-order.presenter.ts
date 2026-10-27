import type {
  WorkOrderAttachment as AttachmentDto,
  WorkOrderDetail,
  WorkOrderItem as ItemDto,
  WorkOrderSummary as SummaryDto,
} from '@ftth/shared';
import type { WorkOrderView } from '../application/work-order-queries.js';
import { itemAmount, type WorkOrderItem } from '../domain/work-order.js';
import type { WorkOrderAttachment, WorkOrderSummary } from '../domain/work-order.repository.js';

export function toItemDto(item: WorkOrderItem, workOrderId: string): ItemDto {
  return {
    id: item.id,
    workOrderId,
    lineNo: item.lineNo,
    code: item.code,
    description: item.description,
    unit: item.unit,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
    amount: itemAmount(item).toString(),
    source: item.source,
    sourceRow: item.sourceRow,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function toAttachmentDto(attachment: WorkOrderAttachment): AttachmentDto {
  return {
    id: attachment.id,
    workOrderId: attachment.workOrderId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType as AttachmentDto['contentType'],
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    uploadedById: attachment.uploadedById,
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function toSummaryDto(summary: WorkOrderSummary): SummaryDto {
  const { header } = summary;
  return {
    id: header.id,
    projectId: header.projectId,
    number: header.number,
    title: header.title,
    issuedOn: header.issuedOn,
    currency: header.currency,
    source: header.source,
    itemCount: summary.itemCount,
    total: summary.total.toString(),
    attachmentCount: summary.attachmentCount,
    version: header.version,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
  };
}

export function toDetailDto({ order, attachments }: WorkOrderView): WorkOrderDetail {
  const { header } = order;
  return {
    ...toSummaryDto({
      header,
      itemCount: order.items.length,
      total: order.total,
      attachmentCount: attachments.length,
    }),
    notes: header.notes,
    items: order.items.map((item) => toItemDto(item, header.id)),
    attachments: attachments.map(toAttachmentDto),
    duplicateCodes: order.duplicateCodes(),
  };
}
