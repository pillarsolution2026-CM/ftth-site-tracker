import type { GpsProposal } from '@ftth/shared';
import type { GpsProposalRecord } from '../domain/gps-proposal.js';

export function toGpsProposalDto(record: GpsProposalRecord): GpsProposal {
  return {
    id: record.id,
    designRevisionId: record.designRevisionId,
    revNo: record.revNo,
    cadFileId: record.cadFileId,
    featureId: record.featureId,
    featureType: record.featureType,
    code: record.code,
    handle: record.handle,
    lat: record.lat,
    lon: record.lon,
    accuracyM: record.accuracyM,
    fixAt: record.fixAt.toISOString(),
    receivedAt: record.receivedAt.toISOString(),
    proposedBy: record.proposedBy,
    note: record.note,
    photo: record.photo,
    status: record.status,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    rejectReason: record.rejectReason,
    acceptedMappingVersion: record.acceptedMappingVersion,
  };
}
