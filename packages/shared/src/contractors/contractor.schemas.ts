import { z } from 'zod';
import {
  CurrencyCodeSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  DecimalStringSchema,
} from '../common/decimal.js';
import { WorkTypeSchema } from '../work-orders/work-order.schemas.js';

/**
 * Subcontractors (المقاولين الباطن) and their prices, Phase 2 point 2-أ part 1, ADR-036.
 * Owner decisions, 2026-11-07:
 * - Only platform admins register a contractor and edit its quantities and prices; PMs read.
 * - A contractor is entered once in a shared list, then registered on a work order
 *   (أمر التكليف / المشروع) with its registration date, items and prices.
 * - A contractor line is a line of the work order (same description and unit, so the contract's).
 *   Its price is at most the contract price. Over every contractor of the work order, the sum of
 *   quantities on a line is at most the work-order quantity.
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

// ---------- a contractor on a work order (admin writes) ----------

/** A work-order line given to the contractor, with its first price. */
export const ContractorLineInputSchema = z.strictObject({
  workOrderItemId: z.uuid(),
  /** > 0. */
  quantity: Decimal4StringSchema.refine((value) => !/^0(\.0+)?$/.test(value), {
    message: 'Quantity must be above 0',
  }),
  /** At most the contract price of the line. Effective from the registration date. */
  unitPrice: Decimal6StringSchema,
});
export type ContractorLineInput = z.infer<typeof ContractorLineInputSchema>;

/**
 * POST /admin/projects/:projectId/contractors. Registers a contractor from the list on the
 * project's work order. At least one line (owner: the item list is required). Lines must be
 * distinct.
 */
export const RegisterContractorRequestSchema = z
  .strictObject({
    contractorId: z.uuid(),
    /** Date the contractor was registered on the work order, `YYYY-MM-DD`. Fixed afterwards. */
    registeredOn: z.iso.date(),
    lines: z.array(ContractorLineInputSchema).min(1).max(5000),
  })
  .refine(
    (body) => new Set(body.lines.map((line) => line.workOrderItemId)).size === body.lines.length,
    { message: 'A work-order line appears more than once', path: ['lines'] },
  );
export type RegisterContractorRequest = z.infer<typeof RegisterContractorRequestSchema>;

/** POST /admin/projects/:projectId/contractors/:registrationId/lines. */
export const AddContractorLineRequestSchema = ContractorLineInputSchema;
export type AddContractorLineRequest = z.infer<typeof AddContractorLineRequestSchema>;

/** PATCH /admin/projects/:projectId/contractors/:registrationId/lines/:lineId. Quantity only. */
export const UpdateContractorLineRequestSchema = z.strictObject({
  quantity: ContractorLineInputSchema.shape.quantity,
});
export type UpdateContractorLineRequest = z.infer<typeof UpdateContractorLineRequestSchema>;

/**
 * POST /admin/projects/:projectId/contractors/:registrationId/lines/:lineId/prices.
 * A new price from `effectiveFrom`, which must come after the line's latest price date
 * (`PRICE_DATE_NOT_AFTER_LATEST`). Work before that date keeps the earlier price.
 */
export const AddContractorPriceRequestSchema = z.strictObject({
  effectiveFrom: z.iso.date(),
  unitPrice: Decimal6StringSchema,
});
export type AddContractorPriceRequest = z.infer<typeof AddContractorPriceRequestSchema>;

/*
 * DELETE /admin/projects/:projectId/contractors/:registrationId and
 * DELETE …/lines/:lineId: allowed while no work is recorded on them. Recording comes in part 2,
 * so for now both are always allowed. Their prices go with them; the event keeps a snapshot.
 */

/**
 * `details.reason` of 409 CONFLICT from contractor writes:
 * - CONTRACTOR_NAME_TAKEN: another contractor has this name (ignoring case and outer spaces).
 * - NO_WORK_ORDER: the project has no work order yet.
 * - CONTRACTOR_ALREADY_REGISTERED: the contractor is already on this work order.
 * - LINE_NOT_IN_WORK_ORDER: the work-order line is not a line of this project's work order.
 * - LEGACY_ITEM: the work-order line was saved before ADR-028 (no contract item).
 * - LINE_REPEATED: the contractor already has this work-order line.
 * - QUANTITY_EXCEEDS_WORK_ORDER: details also carry `workOrderItemId`, `code`,
 *   `workOrderQuantity`, `reservedQuantity` (other contractors' lines), `requestedQuantity`,
 *   `availableQuantity`.
 * - PRICE_EXCEEDS_CONTRACT: details also carry `workOrderItemId`, `code`, `contractPrice`,
 *   `requestedPrice`.
 * - PRICE_DATE_NOT_AFTER_LATEST: details also carry `latestEffectiveFrom`.
 * - LAST_LINE: the only line of a registration cannot be removed (owner: the item list is
 *   required); remove the registration instead.
 */
export const CONTRACTOR_CONFLICT_REASONS = [
  'CONTRACTOR_NAME_TAKEN',
  'NO_WORK_ORDER',
  'CONTRACTOR_ALREADY_REGISTERED',
  'LINE_NOT_IN_WORK_ORDER',
  'LEGACY_ITEM',
  'LINE_REPEATED',
  'QUANTITY_EXCEEDS_WORK_ORDER',
  'PRICE_EXCEEDS_CONTRACT',
  'PRICE_DATE_NOT_AFTER_LATEST',
  'LAST_LINE',
] as const;
export type ContractorConflictReason = (typeof CONTRACTOR_CONFLICT_REASONS)[number];

/**
 * New `details.reason` values of 409 CONFLICT from work-order writes, caused by contractor lines:
 * - QUANTITY_BELOW_CONTRACTORS: a work-order line cannot drop below the sum of its contractor
 *   quantities (details: `workOrderItemId`, `code`, `contractorsQuantity`, `requestedQuantity`).
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
  /** The work-order line's unit price, which is the contract price (ADR-028). */
  contractPrice: DecimalStringSchema,
  quantity: DecimalStringSchema,
  /** Every price of the line, oldest `effectiveFrom` first. The first starts on `registeredOn`. */
  prices: z.array(ContractorPriceSchema).min(1),
});
export type ContractorLine = z.infer<typeof ContractorLineSchema>;

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
  /** In work-order line order. */
  lines: z.array(ContractorLineSchema),
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractorRegistration = z.infer<typeof ContractorRegistrationSchema>;

/** What is left of each work-order line for contractors (the admin's line picker). */
export const ContractorLineAvailabilitySchema = z.object({
  workOrderItemId: z.uuid(),
  lineNo: z.number().int().min(1),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  workType: WorkTypeSchema.nullable(),
  contractPrice: DecimalStringSchema,
  workOrderQuantity: DecimalStringSchema,
  /** Σ quantity of every contractor line on this work-order line. */
  reservedQuantity: DecimalStringSchema,
  /** workOrderQuantity − reservedQuantity. */
  availableQuantity: DecimalStringSchema,
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
