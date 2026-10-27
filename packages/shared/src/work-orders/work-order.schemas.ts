import { z } from 'zod';
import {
  CurrencyCodeSchema,
  Decimal4StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';

/** Upper bound for items in one request (create or import). Technical limit, not a business rule. */
export const MAX_WORK_ORDER_ITEMS = 5000;

export const WORK_ORDER_SOURCES = ['manual', 'import'] as const;
export const WorkOrderSourceSchema = z.enum(WORK_ORDER_SOURCES);
export type WorkOrderSource = z.infer<typeof WorkOrderSourceSchema>;

// ---------- inputs ----------

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Header fields of a work order (أمر التكليف). Only `number` is required (ADR-011 assumption). */
export const WorkOrderHeaderInputSchema = z.object({
  number: z.string().trim().min(1).max(64),
  title: optionalText(200),
  /** Calendar date `YYYY-MM-DD` printed on the work order. */
  issuedOn: z.iso.date().nullable().optional(),
  notes: optionalText(4000),
});
export type WorkOrderHeaderInput = z.infer<typeof WorkOrderHeaderInputSchema>;

/** Required item fields (ADR-011 assumption): code, description, unit, quantity, unitPrice. */
export const WorkOrderItemInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(2000),
  unit: z.string().trim().min(1).max(32),
  quantity: Decimal4StringSchema,
  unitPrice: Decimal4StringSchema,
});
export type WorkOrderItemInput = z.infer<typeof WorkOrderItemInputSchema>;

/** Codes that occur more than once in `items` and are not explicitly accepted. */
export function unacceptedDuplicateCodes(
  items: readonly { code: string }[],
  accepted: readonly string[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.code)) duplicates.add(item.code);
    seen.add(item.code);
  }
  return [...duplicates].filter((code) => !accepted.includes(code));
}

/** POST /projects/:projectId/work-orders. Items are numbered 1..n in array order. */
export const CreateWorkOrderRequestSchema = WorkOrderHeaderInputSchema.extend({
  items: z.array(WorkOrderItemInputSchema).max(MAX_WORK_ORDER_ITEMS).default([]),
  /** Duplicate codes are rejected unless listed here (never merged). */
  acceptedDuplicateCodes: z.array(z.string()).default([]),
}).superRefine((request, ctx) => {
  const rejected = unacceptedDuplicateCodes(request.items, request.acceptedDuplicateCodes);
  if (rejected.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['items'],
      message: `Duplicate item codes must be accepted explicitly: ${rejected.join(', ')}`,
    });
  }
});
export type CreateWorkOrderRequest = z.infer<typeof CreateWorkOrderRequestSchema>;

/** PATCH /projects/:projectId/work-orders/:workOrderId. Currency and source are not editable. */
export const UpdateWorkOrderRequestSchema = WorkOrderHeaderInputSchema.partial()
  .extend({
    /** Optimistic concurrency: must equal the current `version`, else CONFLICT. */
    expectedVersion: z.number().int().min(1),
  })
  .refine(
    (request) =>
      request.number !== undefined ||
      request.title !== undefined ||
      request.issuedOn !== undefined ||
      request.notes !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateWorkOrderRequest = z.infer<typeof UpdateWorkOrderRequestSchema>;

/** POST /projects/:projectId/work-orders/:workOrderId/items */
export const AddWorkOrderItemRequestSchema = WorkOrderItemInputSchema.extend({
  /** Defaults to max(lineNo) + 1. CONFLICT if taken. */
  lineNo: z.number().int().min(1).optional(),
  /** Required to add a code that already exists in this work order (else CONFLICT). */
  acceptDuplicateCode: z.boolean().default(false),
});
export type AddWorkOrderItemRequest = z.infer<typeof AddWorkOrderItemRequestSchema>;

/** PATCH /projects/:projectId/work-orders/:workOrderId/items/:itemId */
export const UpdateWorkOrderItemRequestSchema = WorkOrderItemInputSchema.partial()
  .extend({ acceptDuplicateCode: z.boolean().default(false) })
  .refine(
    (request) =>
      request.code !== undefined ||
      request.description !== undefined ||
      request.unit !== undefined ||
      request.quantity !== undefined ||
      request.unitPrice !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateWorkOrderItemRequest = z.infer<typeof UpdateWorkOrderItemRequestSchema>;

// ---------- outputs ----------

export const ATTACHMENT_KINDS = ['document', 'import_source'] as const;
export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const PDF_CONTENT_TYPE = 'application/pdf' as const;
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
export const ATTACHMENT_CONTENT_TYPES = [PDF_CONTENT_TYPE, XLSX_CONTENT_TYPE] as const;

/** A stored file attached to a work order. `document` = PDF uploaded by a user (not parsed). */
export const WorkOrderAttachmentSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  kind: AttachmentKindSchema,
  fileName: z.string(),
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type WorkOrderAttachment = z.infer<typeof WorkOrderAttachmentSchema>;

export const WorkOrderAttachmentListResponseSchema = z.object({
  items: z.array(WorkOrderAttachmentSchema),
});
export type WorkOrderAttachmentListResponse = z.infer<typeof WorkOrderAttachmentListResponseSchema>;

export const WorkOrderItemSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  lineNo: z.number().int().min(1),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  quantity: DecimalStringSchema,
  unitPrice: DecimalStringSchema,
  /** quantity × unitPrice, exact (no rounding). */
  amount: DecimalStringSchema,
  source: WorkOrderSourceSchema,
  /** Excel row number when imported. */
  sourceRow: z.number().int().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkOrderItem = z.infer<typeof WorkOrderItemSchema>;

export const WorkOrderSummarySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.string(),
  title: z.string().nullable(),
  issuedOn: z.iso.date().nullable(),
  /** Copied from the project when the work order is created. */
  currency: CurrencyCodeSchema,
  source: WorkOrderSourceSchema,
  itemCount: z.number().int().min(0),
  /** Σ quantity × unitPrice, exact. */
  total: DecimalStringSchema,
  attachmentCount: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkOrderSummary = z.infer<typeof WorkOrderSummarySchema>;

export const DuplicateCodeSchema = z.object({
  code: z.string(),
  lineNos: z.array(z.number().int().min(1)).min(2),
});
export type DuplicateCode = z.infer<typeof DuplicateCodeSchema>;

export const WorkOrderDetailSchema = WorkOrderSummarySchema.extend({
  notes: z.string().nullable(),
  items: z.array(WorkOrderItemSchema),
  attachments: z.array(WorkOrderAttachmentSchema),
  /** Codes used by more than one line (accepted explicitly by a user). Shown as warnings. */
  duplicateCodes: z.array(DuplicateCodeSchema),
});
export type WorkOrderDetail = z.infer<typeof WorkOrderDetailSchema>;

export const WorkOrderListResponseSchema = z.object({ items: z.array(WorkOrderSummarySchema) });
export type WorkOrderListResponse = z.infer<typeof WorkOrderListResponseSchema>;
