import { z } from 'zod';
import { CurrencyCodeSchema, DecimalStringSchema } from '../common/decimal.js';
import { CreateUserRequestSchema, LocaleSchema } from '../admin/admin.schemas.js';
import { FeatureTypeSchema } from '../design/feature-types.js';
import { UpdateStatusSchema } from '../execution/execution.schemas.js';

/**
 * Read-only contractor login, subcontractors part 3, ADR-053. Owner decisions, 2026-11-21:
 * - A login account is a user linked to one contractor of the shared list (several accounts per
 *   company). ONLY THE PLATFORM ADMIN creates, stops and restarts them (owner, after the security
 *   review: an account sees every project of its contractor, so a PM of one project must not
 *   hold its password). A contractor account holds no project role and cannot be made admin.
 * - The contractor logs in on the web and in the mobile app (read-only, readable offline).
 * - He sees, for every work order he is registered on: his lines, quantities and prices; and the
 *   work recorded on him as a LIST (no drawing): element, date, quantity, review status and
 *   reason, and its VALUE (quantity × his price). Never photos, supervisor name or GPS; never the
 *   client (contract) prices, other contractors, or own-crew work. Enforced on the server.
 * - The price of a work line is his price in force on the day the supervisor RECORDED it on site
 *   (device time, `capturedAt`), read in `CONTRACTOR_PRICE_DAY_TIME_ZONE`.
 * - Values are totalled separately: approved, pending (under review), rejected.
 */

/**
 * ASSUMPTION (ADR-053): the calendar day of `capturedAt` is read in Egypt's time zone; no project
 * stores a time zone yet.
 */
export const CONTRACTOR_PRICE_DAY_TIME_ZONE = 'Africa/Cairo';

// ---------- accounts (platform admin only) ----------

/** A login account of a contractor. Never the password or its hash. */
export const ContractorAccountSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  locale: LocaleSchema,
  isActive: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ContractorAccount = z.infer<typeof ContractorAccountSchema>;

/**
 * GET /admin/projects/:projectId/contractors/:registrationId/accounts (platform admin): every
 * account of the registration's contractor (accounts belong to the contractor, not to the
 * registration, so the same list shows on each of its projects).
 */
export const ContractorAccountListResponseSchema = z.object({
  contractorId: z.uuid(),
  items: z.array(ContractorAccountSchema),
});
export type ContractorAccountListResponse = z.infer<typeof ContractorAccountListResponseSchema>;

/**
 * POST /admin/projects/:projectId/contractors/:registrationId/accounts → 201 ContractorAccount.
 * Same fields and limits as an admin-created user; the initial password is typed by the admin
 * and given to the contractor. 409 CONFLICT `EMAIL_TAKEN` when the email exists.
 */
export const CreateContractorAccountRequestSchema = CreateUserRequestSchema;
export type CreateContractorAccountRequest = z.infer<typeof CreateContractorAccountRequestSchema>;
export type CreateContractorAccountInput = z.input<typeof CreateContractorAccountRequestSchema>;

/**
 * PATCH /admin/projects/:projectId/contractors/:registrationId/accounts/:userId →
 * ContractorAccount. Stop or restart (admin only). Stopping revokes its sessions.
 */
export const UpdateContractorAccountRequestSchema = z.strictObject({ isActive: z.boolean() });
export type UpdateContractorAccountRequest = z.infer<typeof UpdateContractorAccountRequestSchema>;

// ---------- the contractor's own view ----------

export const PortalPriceSchema = z.object({
  effectiveFrom: z.iso.date(),
  unitPrice: DecimalStringSchema,
});
export type PortalPrice = z.infer<typeof PortalPriceSchema>;

/** One of his lines on a work order. No contract price, no other contractor. */
export const PortalLineSchema = z.object({
  contractorLineId: z.uuid(),
  code: z.string(),
  description: z.string(),
  unit: z.string(),
  /** Scope of work; null = the whole line. */
  scope: z.string().nullable(),
  quantity: DecimalStringSchema,
  /** Oldest first; the last one in force today. */
  prices: z.array(PortalPriceSchema).min(1),
  /** Pending + approved work on this line. */
  recordedQuantity: DecimalStringSchema,
});
export type PortalLine = z.infer<typeof PortalLineSchema>;

export const PortalRegistrationSchema = z.object({
  registrationId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  workOrderNumber: z.string(),
  currency: CurrencyCodeSchema,
  registeredOn: z.iso.date(),
  lines: z.array(PortalLineSchema),
});
export type PortalRegistration = z.infer<typeof PortalRegistrationSchema>;

/** One work line recorded on him. Never photos, supervisor, GPS or note. */
export const PortalWorkSchema = z.object({
  /** Stable key: `${updateId}:${lineNo}`. */
  key: z.string(),
  registrationId: z.uuid(),
  contractorLineId: z.uuid(),
  /**
   * The drawn element: its type and code (code null when the drawing gives none). Null on a
   * «التخطيط» update recorded on the drawing itself (ADR-056).
   */
  element: z.object({ featureType: FeatureTypeSchema, code: z.string().nullable() }).nullable(),
  /** Day recorded on site (`capturedAt` in CONTRACTOR_PRICE_DAY_TIME_ZONE). */
  workDate: z.iso.date(),
  quantity: DecimalStringSchema,
  status: UpdateStatusSchema,
  /** The reviewer's reason (rejections); null otherwise. */
  reviewReason: z.string().nullable(),
  /** His price in force on `workDate` (the first price when the day is before it). */
  unitPrice: DecimalStringSchema,
  /** quantity × unitPrice, exact (not rounded). */
  value: DecimalStringSchema,
});
export type PortalWork = z.infer<typeof PortalWorkSchema>;

/** Exact value totals of one currency. */
export const PortalTotalsSchema = z.object({
  currency: CurrencyCodeSchema,
  approved: DecimalStringSchema,
  pending: DecimalStringSchema,
  rejected: DecimalStringSchema,
});
export type PortalTotals = z.infer<typeof PortalTotalsSchema>;

/**
 * GET /contractor/me: everything the logged-in contractor account may see, in one answer so the
 * phone can keep it offline. 403 FORBIDDEN for any user that is not an active contractor account.
 * `work` newest first.
 */
export const ContractorPortalResponseSchema = z.object({
  serverTime: z.iso.datetime({ offset: true }),
  contractor: z.object({ id: z.uuid(), name: z.string() }),
  registrations: z.array(PortalRegistrationSchema),
  work: z.array(PortalWorkSchema),
  /** One entry per currency of his registrations. */
  totals: z.array(PortalTotalsSchema),
});
export type ContractorPortalResponse = z.infer<typeof ContractorPortalResponseSchema>;
