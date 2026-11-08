import type { GpsProposalFeatureType, GpsProposalStatus, GpsProposalListQuery } from '@ftth/shared';

/** A supervisor's GPS point proposal as the PM sees it (ADR-037). Dates are real dates here. */
export interface GpsProposalRecord {
  id: string;
  projectId: string;
  designRevisionId: string;
  revNo: number;
  cadFileId: string;
  featureId: string;
  featureType: GpsProposalFeatureType;
  code: string | null;
  handle: string;
  lat: number;
  lon: number;
  accuracyM: number;
  fixAt: Date;
  receivedAt: Date;
  proposedBy: { id: string; name: string };
  note: string | null;
  photo: { id: string; stored: boolean } | null;
  status: GpsProposalStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  acceptedMappingVersion: number | null;
}

export type GpsProposalDecision =
  | { status: 'accepted'; decidedBy: string; decidedAt: Date; mappingVersion: number }
  | { status: 'rejected'; decidedBy: string; decidedAt: Date; reason: string };

/** Every method filters by `projectId` (IDOR defence): another project's id is "not found". */
export interface GpsProposalRepository {
  /** Newest first. */
  list(projectId: string, query: GpsProposalListQuery): Promise<GpsProposalRecord[]>;
  find(
    projectId: string,
    proposalId: string,
    options?: { lock?: boolean },
  ): Promise<GpsProposalRecord | null>;
  /** The stored photo's key; `exists: false` when the proposal is unknown or has no photo. */
  photo(
    projectId: string,
    proposalId: string,
  ): Promise<{ storageKey: string | null } | null>;
  /**
   * The item's drawn centre in drawing units, from the published revision's design feature and
   * the extracted rows of the file (an insert's centre / position, a text's position, or the
   * centre of the joint extents of a shape group); null when the rows are gone.
   */
  drawnCentre(
    projectId: string,
    proposal: Pick<GpsProposalRecord, 'designRevisionId' | 'featureId' | 'cadFileId'>,
  ): Promise<{ x: number; y: number } | null>;
  /** pending -> accepted | rejected; false when it was not pending any more. */
  decide(projectId: string, proposalId: string, decision: GpsProposalDecision): Promise<boolean>;
}
