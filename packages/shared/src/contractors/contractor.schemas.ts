import { z } from 'zod';
import {
  CurrencyCodeSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';
import {
  WorkOrderImportPreviewOptionsSchema,
  WorkOrderImportPreviewResponseSchema,
} from '../work-orders/work-order-import.schemas.js';

/**
 * Subcontractors (المقاولين الباطن) and their prices, Phase 2 point 2-أ part 1, ADR-036.
 * Owner decisions, 2026-11-07:
 * - Only platform admins register a contractor and edit its quantities and prices; PMs read.
 * - A contractor is entered once in a shared list, then registered on a work order
 *   (أمر التكليف / المشروع) with its registration date and its list of lines.
 * - The list of lines is UPLOADED as a sheet (like the contract BOQ and the work order), never
 *   typed line by line. Columns: code, description, unit, scope of work, quantity, price.
 * - A contractor line is a line of the work order (same description and unit, so the contract's)
 *   plus a **scope of work** (نطاق الشغل, free text). Empty scope = the whole line. One line can be
 *   split between contractors by scope (e.g. box item: fix bracket / install box / splice box).
 * - Quantity: per work-order line and scope, Σ over every contractor ≤ work-order quantity. A line
 *   given whole and a line with scopes never mix on the same work-order line.
 * - Price: the prices of the scopes on one work-order line add up to at most the contract price.
 *   A scope's price = the highest price ever recorded for that scope on that line (any contractor,
 *   any date); a line given whole counts as one scope.
 * - A price can change from a date; work before that date keeps the old price. Prices are never
 *   overwritten (dated history).
 * Later parts: the supervisor picks the contractor in each update and an overrun is refused
 * (part 2); a read-only contractor login (part 3).
 */

// ---------- shared list of contractors (admin) ----------

const NameSchema = z.string().trim().min(1).max(200);
const optionalCode = z.string().trim().min(1).max(64).nullable().optional();

/**
 * Digits (ASCII or Arabic-Indic), spaces, `+`, `-`, `(`, `)`; 3 to 32 characters.
 * Stored as typed.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9٠-٩][0-9٠-٩ ()-]{1,30}$/, 'Expected a phone number');

/** Required: name, contact person, phone. Optional: commercial register, tax card. */
export const ContractorInputSchema = z.strictObject({
  name: NameSchema,
  contactName: NameSchema,
  contactPhone: PhoneSchema,
  commercialRegister: optionalCode,
  taxCard: optionalCode,
});
export type ContractorInput = z.infer<typeof ContractorInputSchema>;

/** POST /admin/contractors. CONFLICT `CONTRACTOR_NAME_TAKEN` if the name exists (ignoring case). */
export const CreateContractorRequestSchema = ContractorInputSchema;
export type CreateContractorRequest = z.infer<typeof CreateContractorRequestSchema>;

/** PATCH /admin/contractors/:contractorId. */
export const UpdateContractorRequestSchema = ContractorInputSchema.partial()
  .extend({ expectedVersion: z.number().int().min(1) })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.contactName !== undefined ||
      body.contactPhone !== undefined ||
      body.commercialRegister !== undefined ||
      body.taxCard !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateContractorRequest = z.infer<typeof UpdateContractorRequestSchema>;

// ---------- scope of work ----------

export const SCOPE_MAX_LENGTH = 200;

/**
 * Key used to compare scopes: trim, collapse whitespace, lower-case, strip Arabic diacritics and
 * tatweel, unify أ/إ/آ→ا, ة→ه, ى→ي (same normalisation as import headers). So «لحام البوكس» and
 * «لحام  البوكس» are one scope. The scope is stored and shown as typed; only the key is compared.
 * Returns null for an empty scope (= the whole line).
 */
export function scopeKeyOf(scope: string | null | undefined): string | null {
  if (scope === null || scope === undefined) return null;
  const key = scope
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return key === '' ? null : key;
}

// ---------- contractor sheet upload (admin) ----------

/**
 * The contractor's lines come from an uploaded sheet: preview, then commit (same pipeline as the
 * work-order import). Either a NEW registration (contractor from the list + registration date) or
 * lines APPENDED to an existing registration. Rows are matched to the project's work order by code;
 * description and unit must equal the work-order line; quantities and prices are checked against
 * the rules above, including the other rows of the same sheet. Heading rows and rows with an empty
 * quantity are skipped (as in the work-order import). The first price of every new line starts on
 * the registration date.
 */
export const ContractorImportTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new'),
    contractorId: z.uuid(),
    /** Date the contractor was registered on the work order, `YYYY-MM-DD`. Fixed afterwards. */
    registeredOn: z.iso.date(),
  }),
  z.strictObject({ kind: z.literal('append'), registrationId: z.uuid() }),
]);
export type ContractorImportTarget = z.infer<typeof ContractorImportTargetSchema>;

/**
 * `payload` of POST /admin/projects/:projectId/contractors/import/preview (multipart: file +
 * payload). The target is needed to check what the contractor already holds.
 */
export const ContractorImportPreviewOptionsSchema = WorkOrderImportPreviewOptionsSchema.extend({
  target: ContractorImportTargetSchema,
});
export type ContractorImportPreviewOptions = z.infer<typeof ContractorImportPreviewOptionsSchema>;

/** Rows carry `scope`; `workType` and `amount` are not used. */
export const ContractorImportPreviewResponseSchema = WorkOrderImportPreviewResponseSchema;
export type ContractorImportPreviewResponse = z.infer<typeof ContractorImportPreviewResponseSchema>;

/** Code, description, unit, quantity and price are required; scope is optional; work type unused. */
export const ContractorConfirmedColumnMappingSchema = z
  .object({
    code: z.number().int().min(0),
    description: z.number().int().min(0),
    unit: z.number().int().min(0),
    quantity: z.number().int().min(0),
    unitPrice: z.number().int().min(0),
    scope: z.number().int().min(0).nullable().default(null),
    workType: z.number().int().min(0).nullable().default(null),
    amount: z.number().int().min(0).nullable().default(null),
  })
  .superRefine((mapping, ctx) => {
    const used = Object.values(mapping).filter((value): value is number => value !== null);
    if (new Set(used).size !== used.length) {
      ctx.addIssue({ code: 'custom', message: 'A column is mapped to more than one field' });
    }
  });
export type ContractorConfirmedColumnMapping = z.infer<
  typeof ContractorConfirmedColumnMappingSchema
>;

/**
 * `payload` of POST /admin/projects/:projectId/contractors/import (multipart: file + payload).
 * Every included row must be free of errors (IMPORT_INVALID otherwise, same details as the
 * work-order import). 409 `NO_WORK_ORDER`, `CONTRACTOR_ALREADY_REGISTERED` (new target).
 * Answers 201 with the project's `ProjectContractorsResponse`. The file is kept (write-once).
 */
export const ContractorImportCommitPayloadSchema = z.object({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sheetName: z.string().min(1).max(255),
  headerRow: z.number().int().min(1),
  mapping: ContractorConfirmedColumnMappingSchema,
  excludedRowNumbers: z.array(z.number().int().min(1)).default([]),
  target: ContractorImportTargetSchema,
});
export type ContractorImportCommitPayload = z.infer<typeof ContractorImportCommitPayloadSchema>;

// ---------- single-field edits (admin) ----------

/** PATCH /admin/projects/:projectId/contractors/:registrationId/lines/:lineId. Quantity only, > 0. */
export const UpdateContractorLineRequestSchema = z.strictObject({
  quantity: Decimal4StringSchema.refine((value) => !/^0(\.0+)?$/.test(value), {
    message: 'Quantity must be above 0',
  }),
});
export type UpdateContractorLineRequest = z.infer<typeof UpdateContractorLineRequestSchema>;

/**
 * POST /admin/projects/:projectId/contractors/:registrationId/lines/:lineId/prices.
 * A new price from `effectiveFrom`, which must come after the line's latest price date
 * (`PRICE_DATE_NOT_AFTER_LATEST`). Work before that date keeps the earlier price. The scopes'
 * prices on the work-order line must still add up to at most the contract price.
 */
export const AddContractorPriceRequestSchema = z.strictObject({
  effectiveFrom: z.iso.date(),
  unitPrice: Decimal6StringSchema,
});
export type AddContractorPriceRequest = z.infer<typeof AddContractorPriceRequestSchema>;

/*
 * DELETE /admin/projects/:projectId/contractors/:registrationId and
 * DELETE …/lines/:lineId: allowed while no work is recorded on them. Recording comes in part 2,
 * so for now both are always allowed (but not the last line, LAST_LINE). Their prices go with
 * them; the event keeps a snapshot.
 */

/**
 * `details.reason` of 409 CONFLICT from contractor writes:
 * - CONTRACTOR_NAME_TAKEN: another contractor has this name (ignoring case and outer spaces).
 * - NO_WORK_ORDER: the project has no work order yet.
 * - CONTRACTOR_ALREADY_REGISTERED: the contractor is already on this work order.
 * - QUANTITY_EXCEEDS_WORK_ORDER: details also carry `workOrderItemId`, `code`, `scope`,
 *   `workOrderQuantity`, `reservedQuantity` (other contractors on the same scope),
 *   `requestedQuantity`, `availableQuantity`.
 * - PRICE_EXCEEDS_CONTRACT: details also carry `workOrderItemId`, `code`, `contractPrice`,
 *   `otherScopesPrice`, `maxAllowedPrice`, `requestedPrice`.
 * - PRICE_DATE_NOT_AFTER_LATEST: details also carry `latestEffectiveFrom`.
 * - LAST_LINE: the only line of a registration cannot be removed (owner: the list is required);
 *   remove the registration instead.
 * - LINE_NOT_IN_WORK_ORDER, LEGACY_ITEM, LINE_REPEATED, WHOLE_AND_SCOPES_MIXED: the database
 *   refused an import row that changed after its preview (concurrent write); preview again.
 */
export const CONTRACTOR_CONFLICT_REASONS = [
  'CONTRACTOR_NAME_TAKEN',
  'NO_WORK_ORDER',
  'CONTRACTOR_ALREADY_REGISTERED',
  'QUANTITY_EXCEEDS_WORK_ORDER',
  'PRICE_EXCEEDS_CONTRACT',
  'PRICE_DATE_NOT_AFTER_LATEST',
  'LAST_LINE',
  'LINE_NOT_IN_WORK_ORDER',
  'LEGACY_ITEM',
  'LINE_REPEATED',
  'WHOLE_AND_SCOPES_MIXED',
] as const;
export type ContractorConflictReason = (typeof CONTRACTOR_CONFLICT_REASONS)[number];

/**
 * New `details.reason` values of 409 CONFLICT from work-order writes, caused by contractor lines:
 * - QUANTITY_BELOW_CONTRACTORS: a work-order line cannot drop below what any one scope of its
 *   contractors holds (details: `workOrderItemId`, `code`, `contractorsQuantity` = the largest
 *   scope sum, `requestedQuantity`).
 * - LINE_HAS_CONTRACTORS: a work-order line given to a contractor cannot be removed.
 * - WORK_ORDER_HAS_CONTRACTORS: a work order with registered contractors cannot be deleted.
 */
export const WORK_ORDER_CONTRACTOR_CONFLICT_REASONS = [
  'QUANTITY_BELOW_CONTRACTORS',
  'LINE_HAS_CONTRACTORS',
  'WORK_ORDER_HAS_CONTRACTORS',
] as const;
export type WorkOrderContractorConflictReason =
  (typeof WORK_ORDER_CONTRACTOR_CONFLICT_REASONS)[number];

// ---------- outputs ----------

export const ContractorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
  commercialRegister: z.string().nullable(),
  taxCard: z.string().nullable(),
  /** Work orders the contractor is registered on. */
  workOrderCount: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Contractor = z.infer<typeof ContractorSchema>;

export const ContractorListResponseSchema = z.object({ items: z.array(ContractorSchema) });
export type ContractorListResponse = z.infer<typeof ContractorListResponseSchema>;

export const ContractorPriceSchema = z.object({
  id: z.uuid(),
  effectiveFrom: z.iso.date(),
  unitPrice: DecimalStringSchema,
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractorPrice = z.infer<typeof ContractorPriceSchema>;

export const ContractorLineSchema = z.object({
  id: z.uuid(),
  workOrderItemId: z.uuid(),
  /** Copied for display from the work-order line (which copies the contract item). */
  lineNo: z.number().int().min(1),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  workType: WorkTypeSchema.nullable(),
  /** Scope of work as typed in the sheet; null = the whole line. */
  scope: z.string().nullable(),
  /** The work-order line's unit price, which is the contract price (ADR-028). */
  contractPrice: DecimalStringSchema,
  quantity: DecimalStringSchema,
  /** Every price of the line, oldest `effectiveFrom` first. The first starts on `registeredOn`. */
  prices: z.array(ContractorPriceSchema).min(1),
  /** Sheet row the line came from. */
  sourceRow: z.number().int().min(1).nullable(),
});
export type ContractorLine = z.infer<typeof ContractorLineSchema>;

export const ContractorImportFileSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedById: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractorImportFile = z.infer<typeof ContractorImportFileSchema>;

export const ContractorRegistrationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  workOrderId: z.uuid(),
  contractor: ContractorSchema.pick({
    id: true,
    name: true,
    contactName: true,
    contactPhone: true,
    commercialRegister: true,
    taxCard: true,
  }),
  registeredOn: z.iso.date(),
  /** In work-order line order, then scope. */
  lines: z.array(ContractorLineSchema),
  /** Sheets uploaded for this registration, oldest first. */
  files: z.array(ContractorImportFileSchema),
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractorRegistration = z.infer<typeof ContractorRegistrationSchema>;

/** One scope of a work-order line across every contractor (whole line: `scope` null). */
export const ContractorScopeUsageSchema = z.object({
  /** As first typed. */
  scope: z.string().nullable(),
  /** Σ quantity of every contractor line with this scope. */
  reservedQuantity: DecimalStringSchema,
  /** workOrderQuantity − reservedQuantity. */
  availableQuantity: DecimalStringSchema,
  /** Highest price ever recorded for this scope (the amount counted against the contract price). */
  highestPrice: DecimalStringSchema,
});
export type ContractorScopeUsage = z.infer<typeof ContractorScopeUsageSchema>;

/** What is left of each work-order line for contractors. */
export const ContractorLineAvailabilitySchema = z.object({
  workOrderItemId: z.uuid(),
  lineNo: z.number().int().min(1),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  workType: WorkTypeSchema.nullable(),
  contractPrice: DecimalStringSchema,
  workOrderQuantity: DecimalStringSchema,
  /** `free`: no contractor yet; `whole`: given whole; `scoped`: split by scope. */
  mode: z.enum(['free', 'whole', 'scoped']),
  scopes: z.array(ContractorScopeUsageSchema),
  /** Σ highestPrice over the scopes. */
  scopesPriceTotal: DecimalStringSchema,
  /** contractPrice − scopesPriceTotal: the most a new scope may cost. */
  priceRoom: DecimalStringSchema,
  /** False for lines saved before ADR-028: they cannot be given to a contractor. */
  assignable: z.boolean(),
});
export type ContractorLineAvailability = z.infer<typeof ContractorLineAvailabilitySchema>;

/**
 * GET /admin/projects/:projectId/contractors (admin) and GET /projects/:projectId/contractors
 * (`contractors:read`: admin, pm). `workOrderId` is null while the project has no work order.
 */
export const ProjectContractorsResponseSchema = z.object({
  projectId: z.uuid(),
  workOrderId: z.uuid().nullable(),
  currency: CurrencyCodeSchema,
  registrations: z.array(ContractorRegistrationSchema),
  availability: z.array(ContractorLineAvailabilitySchema),
});
export type ProjectContractorsResponse = z.infer<typeof ProjectContractorsResponseSchema>;
