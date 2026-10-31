import { z } from 'zod';
import {
  CurrencyCodeSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';
import {
  ITEM_TEXT_LIMITS,
  MAX_WORK_ORDER_ITEMS,
  WorkTypeSchema,
} from '../work-orders/work-order.schemas.js';
import {
  ConfirmedColumnMappingSchema,
  WorkOrderImportPreviewOptionsSchema,
  WorkOrderImportPreviewResponseSchema,
} from '../work-orders/work-order-import.schemas.js';

/**
 * Contract (العقد) and its BOQ (المقايسة), Phase 2, ADR-027.
 *
 * - A contract sits above projects. Each project is one work order (أمر التكليف / المشروع) and
 *   belongs to one contract; its currency is the contract's currency.
 * - Only platform admins create a contract, import or edit its BOQ and approve it. PMs read it.
 * - Approval is final: the BOQ (items and headings) can no longer change. Header fields other than
 *   the currency stay editable.
 * - Prices are in the contract currency without tax (owner, 2026-10-31); tax and discounts for
 *   incomplete work come with invoicing (Phase 5).
 */

export const MAX_CONTRACT_ITEMS = MAX_WORK_ORDER_ITEMS;

export const CONTRACT_STATUSES = ['draft', 'approved'] as const;
export const ContractStatusSchema = z.enum(CONTRACT_STATUSES);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

/**
 * `item` = a priced BOQ line. `heading` = a section title (row without unit and price in the
 * sheet, owner 2026-10-31); it has a code, an optional description and nothing else, and is shown
 * as a category. A priced item may have priced children (e.g. 2-9-1 and 2-9-1-1).
 */
export const CONTRACT_ITEM_KINDS = ['item', 'heading'] as const;
export const ContractItemKindSchema = z.enum(CONTRACT_ITEM_KINDS);
export type ContractItemKind = z.infer<typeof ContractItemKindSchema>;

export const CONTRACT_SOURCES = ['manual', 'import'] as const;
export const ContractSourceSchema = z.enum(CONTRACT_SOURCES);
export type ContractSource = z.infer<typeof ContractSourceSchema>;

/** Nearest ancestor code present in `codes`, by dropping trailing `-n` segments (`2-9-1-1` → `2-9-1`). */
export function parentCodeOf(code: string, codes: ReadonlySet<string>): string | null {
  let current = code;
  for (let cut = current.lastIndexOf('-'); cut > 0; cut = current.lastIndexOf('-')) {
    current = current.slice(0, cut);
    if (codes.has(current)) return current;
  }
  return null;
}

// ---------- inputs ----------

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const NameSchema = z.string().trim().min(1).max(200);

/** Header of a contract. Number, name, client and currency are required. */
export const ContractHeaderInputSchema = z.strictObject({
  number: z.string().trim().min(1).max(64),
  name: NameSchema,
  client: NameSchema,
  /** Calendar date `YYYY-MM-DD` the contract starts. */
  startsOn: z.iso.date().nullable().optional(),
  /** Contract duration in days. */
  durationDays: z.number().int().min(1).max(36500).nullable().optional(),
  notes: optionalText(4000),
});
export type ContractHeaderInput = z.infer<typeof ContractHeaderInputSchema>;

/** POST /admin/contracts. Creates an empty draft. */
export const CreateContractRequestSchema = ContractHeaderInputSchema.extend({
  /** ISO 4217; fixed after creation (projects and work orders copy it). */
  currency: CurrencyCodeSchema,
});
export type CreateContractRequest = z.infer<typeof CreateContractRequestSchema>;

/** PATCH /admin/contracts/:contractId. Allowed in draft and after approval; currency never. */
export const UpdateContractRequestSchema = ContractHeaderInputSchema.partial()
  .extend({ expectedVersion: z.number().int().min(1) })
  .refine(
    (body) =>
      body.number !== undefined ||
      body.name !== undefined ||
      body.client !== undefined ||
      body.startsOn !== undefined ||
      body.durationDays !== undefined ||
      body.notes !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateContractRequest = z.infer<typeof UpdateContractRequestSchema>;

/** A priced line, same required fields as a work-order item (ADR-011, ADR-016). Quantity may be 0. */
const PricedItemInputSchema = z.strictObject({
  kind: z.literal('item'),
  code: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.code),
  description: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.description),
  unit: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.unit),
  quantity: Decimal4StringSchema,
  unitPrice: Decimal6StringSchema,
  workType: WorkTypeSchema,
});

/** A section title. The description may be empty (e.g. `2-12` in the sample BOQ). */
const HeadingInputSchema = z.strictObject({
  kind: z.literal('heading'),
  code: z.string().trim().min(1).max(ITEM_TEXT_LIMITS.code),
  description: z.string().trim().max(ITEM_TEXT_LIMITS.description).nullable().optional(),
});

export const ContractItemInputSchema = z.discriminatedUnion('kind', [
  PricedItemInputSchema,
  HeadingInputSchema,
]);
export type ContractItemInput = z.infer<typeof ContractItemInputSchema>;

/** POST /admin/contracts/:contractId/items (draft only). */
export const AddContractItemRequestSchema = z.object({
  item: ContractItemInputSchema,
  /** Defaults to max(lineNo) + 1. CONFLICT if taken. */
  lineNo: z.number().int().min(1).optional(),
  /** Required to add a code that already exists in this contract (else CONFLICT). */
  acceptDuplicateCode: z.boolean().default(false),
  expectedVersion: z.number().int().min(1),
});
export type AddContractItemRequest = z.infer<typeof AddContractItemRequestSchema>;

/** PATCH /admin/contracts/:contractId/items/:itemId (draft only). Replaces the line's content. */
export const UpdateContractItemRequestSchema = z.object({
  item: ContractItemInputSchema,
  acceptDuplicateCode: z.boolean().default(false),
  expectedVersion: z.number().int().min(1),
});
export type UpdateContractItemRequest = z.infer<typeof UpdateContractItemRequestSchema>;

/** DELETE /admin/contracts/:contractId/items/:itemId?expectedVersion=n (draft only). */
export const RemoveContractItemQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
});

/** POST /admin/contracts/:contractId/approve. Needs at least one priced item. Irreversible. */
export const ApproveContractRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type ApproveContractRequest = z.infer<typeof ApproveContractRequestSchema>;

// ---------- BOQ import (same pipeline as the work-order import) ----------

/** `payload` of POST /admin/contracts/:contractId/import/preview. */
export const ContractImportPreviewOptionsSchema = WorkOrderImportPreviewOptionsSchema;
export type ContractImportPreviewOptions = z.infer<typeof ContractImportPreviewOptionsSchema>;

export const ContractImportPreviewResponseSchema = WorkOrderImportPreviewResponseSchema;
export type ContractImportPreviewResponse = z.infer<typeof ContractImportPreviewResponseSchema>;

/**
 * `payload` of POST /admin/contracts/:contractId/import (draft only). Replaces every line of the
 * contract with the included rows: priced rows become items, heading rows become headings.
 * Errors and duplicate decisions behave as in the work-order import (IMPORT_INVALID).
 */
export const ContractImportCommitPayloadSchema = z.object({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sheetName: z.string().min(1).max(255),
  headerRow: z.number().int().min(1),
  mapping: ConfirmedColumnMappingSchema,
  excludedRowNumbers: z.array(z.number().int().min(1)).default([]),
  acceptedDuplicateCodes: z.array(z.string()).default([]),
  expectedVersion: z.number().int().min(1),
});
export type ContractImportCommitPayload = z.infer<typeof ContractImportCommitPayloadSchema>;

// ---------- outputs ----------

export const ContractItemSchema = z.object({
  id: z.uuid(),
  contractId: z.uuid(),
  lineNo: z.number().int().min(1),
  kind: ContractItemKindSchema,
  code: z.string(),
  /** Null only for a heading without a title. */
  description: z.string().nullable(),
  /** Nearest ancestor line by code (see `parentCodeOf`); null at the top. */
  parentCode: z.string().nullable(),
  /** The fields below are null for headings and set for items. */
  unit: z.string().nullable(),
  /** Contract quantity (كمية التعاقد). */
  quantity: DecimalStringSchema.nullable(),
  unitPrice: DecimalStringSchema.nullable(),
  /** quantity × unitPrice, exact. */
  amount: DecimalStringSchema.nullable(),
  workType: WorkTypeSchema.nullable(),
  source: ContractSourceSchema,
  sourceRow: z.number().int().min(1).nullable(),
});
export type ContractItem = z.infer<typeof ContractItemSchema>;

export const ContractAttachmentSchema = z.object({
  id: z.uuid(),
  contractId: z.uuid(),
  kind: z.enum(['document', 'import_source']),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedById: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractAttachment = z.infer<typeof ContractAttachmentSchema>;

export const ContractSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  client: z.string(),
  currency: CurrencyCodeSchema,
  startsOn: z.iso.date().nullable(),
  durationDays: z.number().int().nullable(),
  status: ContractStatusSchema,
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Priced items only (headings excluded). */
  itemCount: z.number().int().min(0),
  /** Σ quantity × unitPrice over items, exact. */
  total: DecimalStringSchema,
  /** Projects (work orders) under this contract. */
  projectCount: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ContractSummary = z.infer<typeof ContractSummarySchema>;

export const ContractDetailSchema = ContractSummarySchema.extend({
  notes: z.string().nullable(),
  approvedById: z.uuid().nullable(),
  /** Every line in lineNo order, headings included. */
  items: z.array(ContractItemSchema),
  attachments: z.array(ContractAttachmentSchema),
  /** Codes used by more than one line (accepted explicitly). */
  duplicateCodes: z.array(
    z.object({ code: z.string(), lineNos: z.array(z.number().int().min(1)).min(2) }),
  ),
});
export type ContractDetail = z.infer<typeof ContractDetailSchema>;

export const ContractListResponseSchema = z.object({ items: z.array(ContractSummarySchema) });
export type ContractListResponse = z.infer<typeof ContractListResponseSchema>;
