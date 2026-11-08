import {
  GPS_PROPOSAL_MAX_ACCURACY_M,
  ProposePlacementPointOpSchema,
  isGpsProposalFeatureType,
  type GpsFix,
  type ProposePlacementPointOp,
} from '@ftth/shared';
import type { CapturedPhoto } from '../../update/model/update-wizard';

/** The «ابعت نقطتي» button is offered on cabinets, handholes, manholes, joints and boxes only. */
export function canProposePoint(featureType: string): boolean {
  return isGpsProposalFeatureType(featureType);
}

export type AccuracyGate = 'no_fix' | 'too_low' | 'ok';

/**
 * The phone refuses a fix worse than ±5 m (owner 2026-11-08); a fix without accuracy cannot be
 * checked, so it is refused too. Exactly the limit is allowed (the server uses the same rule).
 */
export function accuracyGate(accuracyM: number | null | undefined): AccuracyGate {
  if (accuracyM === null || accuracyM === undefined || Number.isNaN(accuracyM)) return 'no_fix';
  return accuracyM <= GPS_PROPOSAL_MAX_ACCURACY_M ? 'ok' : 'too_low';
}

export function canSendProposal(fix: GpsFix | null): fix is GpsFix & { accuracyM: number } {
  return fix !== null && accuracyGate(fix.accuracyM) === 'ok';
}

/** Accuracy as shown to the user: one decimal, never negative. */
export function formatAccuracy(accuracyM: number): string {
  return Math.max(0, accuracyM).toFixed(1);
}

export interface ProposalInput {
  clientOpId: string;
  capturedAt: string;
  designRevisionId: string;
  featureId: string;
  /** The reading frozen at the moment the user pressed send. */
  fix: GpsFix & { accuracyM: number };
  photo: CapturedPhoto | null;
  note: string;
}

/** The outbox operation for a proposal, validated with the shared contract. */
export function buildProposeOp(input: ProposalInput): ProposePlacementPointOp {
  const note = input.note.trim();
  return ProposePlacementPointOpSchema.parse({
    kind: 'placement_point.propose',
    clientOpId: input.clientOpId,
    capturedAt: input.capturedAt,
    payload: {
      designRevisionId: input.designRevisionId,
      featureId: input.featureId,
      fix: {
        lat: input.fix.lat,
        lon: input.fix.lon,
        accuracyM: input.fix.accuracyM,
        at: input.fix.at,
      },
      photo: input.photo
        ? {
            photoId: input.photo.photoId,
            requirementKey: 'general',
            sha256: input.photo.sha256,
            sizeBytes: input.photo.sizeBytes,
            contentType: 'image/jpeg',
            takenAt: input.photo.takenAt,
            gps: input.photo.gps,
          }
        : null,
      note: note === '' ? null : note,
    },
  });
}
