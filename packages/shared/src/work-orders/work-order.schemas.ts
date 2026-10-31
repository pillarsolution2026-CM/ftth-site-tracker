import { z } from 'zod';
import {
  CurrencyCodeSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';

/** Upper bound for items in one request (create or import). Technical limit, not a business rule. */
export const MAX_WORK_ORDER_ITEMS = 5000;

/** Longest accepted text per item field (same limits as the work_order_items CHECK constraints). */
export const ITEM_TEXT_LIMITS = { code: 64, description: 2000, unit: 64 } as const;

/**
 * Work type (نوع الأعمال) of an item, a fixed list set by the owner (ADR-016):
 * civil = مدني, installation = تركيبات, planning = تخطيط. Stored as these codes; labels come from i18n.
 */
export const WORK_TYPES = ['civil', 'installation', 'planning'] as const;
export const WorkTypeSchema = z.enum(WORK_TYPES);
export type WorkType = z.infer<typeof WorkTypeSchema>;

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

/**
 * Item fields as stored (ADR-011, ADR-016). Since Phase 2 step 2 (ADR-028) these are copied from
 * the contract item and are not typed by the user; kept for the import parser and old data.
 */
export const WorkOrderItemInputSchema = z.object({
  code: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.code),
  description: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.description),
  unit: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.unit),
  quantity: Decimal4StringSchema,
  unitPrice: Decimal6StringSchema,
  workType: WorkTypeSchema,
});
export type WorkOrderItemInput = z.infer<typeof WorkOrderItemInputSchema>;

/**
 * A work-order line (ADR-028): an item of the project's approved contract and a quantity. Code,
 * description, unit, unit price and work type are copied from the contract item. Each contract
 * item appears at most once per work order, and the sum over every work order of the contract may
 * not exceed the contract quantity (owner, 2026-10-28 / 2026-10-31).
 */
export const WorkOrderLineInputSchema = z.strictObject({
  contractItemId: z.uuid(),
  quantity: Decimal4StringSchema,
});
export type WorkOrderLineInput = z.infer<typeof WorkOrderLineInputSchema>;

/** Contract items used more than once in `lines`. */
export function repeatedContractItemIds(lines: readonly { contractItemId: string }[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.contractItemId)) repeated.add(line.contractItemId);
    seen.add(line.contractItemId);
  }
  return [...repeated];
}

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

/**
 * POST /projects/:projectId/work-orders. Lines are numbered 1..n in array order. The project must
 * belong to an approved contract and have no work order yet (one work order per project).
 */
export const CreateWorkOrderRequestSchema = WorkOrderHeaderInputSchema.extend({
  lines: z.array(WorkOrderLineInputSchema).max(MAX_WORK_ORDER_ITEMS).default([]),
}).superRefine((request, ctx) => {
  const repeated = repeatedContractItemIds(request.lines);
  if (repeated.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lines'],
      message: `A contract item may appear only once: ${repeated.join(', ')}`,
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
export const AddWorkOrderItemRequestSchema = WorkOrderLineInputSchema.extend({
  /** Defaults to max(lineNo) + 1. CONFLICT if taken. */
  lineNo: z.number().int().min(1).optional(),
});
export type AddWorkOrderItemRequest = z.infer<typeof AddWorkOrderItemRequestSchema>;

/** PATCH /projects/:projectId/work-orders/:workOrderId/items/:itemId. Only the quantity changes. */
export const UpdateWorkOrderItemRequestSchema = z.strictObject({
  quantity: Decimal4StringSchema,
});
export type UpdateWorkOrderItemRequest = z.infer<typeof UpdateWorkOrderItemRequestSchema>;

/**
 * `details.reason` of 409 CONFLICT from work-order writes (ADR-028), besides the existing ones:
 * - NO_CONTRACT: the project has no contract.
 * - CONTRACT_NOT_APPROVED: the contract is still a draft ("approve the contract first").
 * - WORK_ORDER_EXISTS: the project already has its work order.
 * - NOT_IN_CONTRACT: the contract item is not a priced item of the project's contract.
 * - CONTRACT_ITEM_REPEATED: the contract item is already a line of this work order.
 * - QUANTITY_EXCEEDS_CONTRACT: details also carry `contractItemId`, `code`, `contractQuantity`,
 *   `reservedQuantity` (other lines of every work order of the contract), `requestedQuantity`,
 *   `availableQuantity`.
 * - LEGACY_ITEM: a line saved before ADR-028 (no contract item) cannot be edited.
 */
export const WORK_ORDER_CONFLICT_REASONS = [
  'NO_CONTRACT',
  'CONTRACT_NOT_APPROVED',
  'WORK_ORDER_EXISTS',
  'NOT_IN_CONTRACT',
  'CONTRACT_ITEM_REPEATED',
  'QUANTITY_EXCEEDS_CONTRACT',
  'LEGACY_ITEM',
] as const;
export type WorkOrderConflictReason = (typeof WORK_ORDER_CONFLICT_REASONS)[number];

/**
 * GET /projects/:projectId/work-orders/contract-items (permission `work_orders:write`): the priced
 * items of the project's approved contract with what is still available, for the line picker.
 */
export const ContractItemAvailabilitySchema = z.object({
  contractItemId: z.uuid(),
  lineNo: z.number().int().min(1),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  unitPrice: DecimalStringSchema,
  workType: WorkTypeSchema,
  contractQuantity: DecimalStringSchema,
  /** Σ quantity over every work-order line of the contract (all projects). */
  reservedQuantity: DecimalStringSchema,
  /** contractQuantity − reservedQuantity. */
  availableQuantity: DecimalStringSchema,
  /** Line of this project's work order using the item, if any. */
  workOrderItemId: z.uuid().nullable(),
});
export type ContractItemAvailability = z.infer<typeof ContractItemAvailabilitySchema>;

export const ContractItemAvailabilityResponseSchema = z.object({
  contractId: z.uuid(),
  contractNumber: z.string(),
  items: z.array(ContractItemAvailabilitySchema),
});
export type ContractItemAvailabilityResponse = z.infer<
  typeof ContractItemAvailabilityResponseSchema
>;

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
  /** null only for items saved before ADR-016; new items need one and an edit must set it. */
  workType: WorkTypeSchema.nullable(),
  /** Contract item this line comes from (ADR-028); null only for lines saved before it. */
  contractItemId: z.uuid().nullable(),
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
