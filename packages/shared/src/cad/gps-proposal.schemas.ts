import { z } from 'zod';
import { PhotoMetaSchema } from '../execution/execution.schemas.js';

/**
 * Supervisor GPS point proposals (ADR-035, ADR-037). A supervisor stands at a point item of the
 * published drawing and sends the phone's fix; a PM accepts it (it becomes a `gps` control point
 * on the mapping of the file that revision was built from, a new mapping version, no build) or
 * rejects it with a reason.
 */

/** Owner 2026-11-08: the phone and the server refuse a fix reported worse than ±5 m. */
export const GPS_PROPOSAL_MAX_ACCURACY_M = 5;

/** Owner 2026-11-08: cabinets, handholes / manholes, joints and boxes only (`ring`: assumption). */
export const GPS_PROPOSAL_FEATURE_TYPES = ['cabinet', 'hhi', 'mh', 'joint', 'box'] as const;
export const GpsProposalFeatureTypeSchema = z.enum(GPS_PROPOSAL_FEATURE_TYPES);
export type GpsProposalFeatureType = z.infer<typeof GpsProposalFeatureTypeSchema>;

export function isGpsProposalFeatureType(value: string): value is GpsProposalFeatureType {
  return (GPS_PROPOSAL_FEATURE_TYPES as readonly string[]).includes(value);
}

export const GPS_PROPOSAL_REJECT_REASON_MAX = 500;

/** The device's fix; `accuracyM` is required here (a fix without accuracy cannot be checked). */
export const GpsProposalFixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(GPS_PROPOSAL_MAX_ACCURACY_M),
  /** Device clock at the fix; evidence only. */
  at: z.iso.datetime({ offset: true }),
});
export type GpsProposalFix = z.infer<typeof GpsProposalFixSchema>;

export const ProposePlacementPointPayloadSchema = z.object({
  /** The published revision shown on the phone, and the point item in it. */
  designRevisionId: z.uuid(),
  featureId: z.uuid(),
  fix: GpsProposalFixSchema,
  /** Optional (owner 2026-11-08); uploaded through the resumable photo upload like update photos. */
  photo: PhotoMetaSchema.nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ProposePlacementPointPayload = z.infer<typeof ProposePlacementPointPayloadSchema>;

/** Sync op (ADR-024 outbox); `updateId` in its result is the proposal id. */
export const ProposePlacementPointOpSchema = z.object({
  kind: z.literal('placement_point.propose'),
  clientOpId: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }),
  payload: ProposePlacementPointPayloadSchema,
});
export type ProposePlacementPointOp = z.infer<typeof ProposePlacementPointOpSchema>;

// ---------- PM side ----------

export const GPS_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const GpsProposalStatusSchema = z.enum(GPS_PROPOSAL_STATUSES);
export type GpsProposalStatus = z.infer<typeof GpsProposalStatusSchema>;

export const GpsProposalSchema = z.object({
  id: z.uuid(),
  designRevisionId: z.uuid(),
  revNo: z.number().int().min(1),
  /** The file that revision was built from: accepting adds the point to this file's mapping. */
  cadFileId: z.uuid(),
  featureId: z.uuid(),
  featureType: GpsProposalFeatureTypeSchema,
  code: z.string().nullable(),
  /** Drawing handle of the item in that file (the control point's `handle`). */
  handle: z.string(),
  lat: z.number(),
  lon: z.number(),
  accuracyM: z.number(),
  fixAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  proposedBy: z.object({ id: z.uuid(), name: z.string() }),
  note: z.string().nullable(),
  /** Present when a photo was attached; `stored` false while it is still uploading. */
  photo: z.object({ id: z.uuid(), stored: z.boolean() }).nullable(),
  status: GpsProposalStatusSchema,
  decidedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  rejectReason: z.string().nullable(),
  /** Mapping version created by accepting it. */
  acceptedMappingVersion: z.number().int().min(1).nullable(),
});
export type GpsProposal = z.infer<typeof GpsProposalSchema>;

export const GpsProposalListQuerySchema = z.object({
  status: GpsProposalStatusSchema.optional(),
  cadFileId: z.uuid().optional(),
});
export type GpsProposalListQuery = z.infer<typeof GpsProposalListQuerySchema>;

export const GpsProposalListResponseSchema = z.object({ items: z.array(GpsProposalSchema) });
export type GpsProposalListResponse = z.infer<typeof GpsProposalListResponseSchema>;

/**
 * `POST /projects/:projectId/gps-proposals/:id/accept`. `mappingVersion` is the version the PM
 * saw (optimistic lock, as when saving the mapping); the answer is the decided proposal.
 */
export const AcceptGpsProposalRequestSchema = z.strictObject({
  mappingVersion: z.number().int().min(1),
});
export type AcceptGpsProposalRequest = z.infer<typeof AcceptGpsProposalRequestSchema>;

export const RejectGpsProposalRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(GPS_PROPOSAL_REJECT_REASON_MAX),
});
export type RejectGpsProposalRequest = z.infer<typeof RejectGpsProposalRequestSchema>;
