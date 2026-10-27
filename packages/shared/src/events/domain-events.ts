/**
 * `events.entity` / `events.type` values introduced in Phase 1a. Payloads carry money and
 * quantities as decimal strings and, for updates, `{ before, after }` of the changed fields only.
 */
export const EVENT_ENTITIES = {
  workOrder: 'work_order',
  workOrderItem: 'work_order_item',
  workOrderAttachment: 'work_order_attachment',
  cadFile: 'cad_file',
} as const;

export const EVENT_TYPES = {
  workOrderCreated: 'work_order.created',
  /** Created by an Excel import; payload includes file sha256, sheet, mapping, row counts. */
  workOrderImported: 'work_order.imported',
  workOrderUpdated: 'work_order.updated',
  /** Payload is a full snapshot of the header and items (the rows are hard-deleted). */
  workOrderDeleted: 'work_order.deleted',
  workOrderItemAdded: 'work_order_item.added',
  workOrderItemUpdated: 'work_order_item.updated',
  workOrderItemRemoved: 'work_order_item.removed',
  workOrderAttachmentAdded: 'work_order_attachment.added',
  workOrderAttachmentRemoved: 'work_order_attachment.removed',
  cadFileUploaded: 'cad_file.uploaded',
  cadFileQueued: 'cad_file.queued',
  /** Written by the worker (actor_id NULL). */
  cadFileProcessingStarted: 'cad_file.processing_started',
  cadFileProcessed: 'cad_file.processed',
  cadFileFailed: 'cad_file.failed',
} as const;
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
