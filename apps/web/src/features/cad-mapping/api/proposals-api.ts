import {
  GpsProposalListResponseSchema,
  GpsProposalSchema,
  type GpsProposal,
  type GpsProposalListResponse,
  type GpsProposalStatus,
} from '@ftth/shared';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

const proposalsPath = (projectId: string) => projectApiPath(projectId, '/gps-proposals');
const onePath = (projectId: string, proposalId: string) =>
  `${proposalsPath(projectId)}/${encodeURIComponent(proposalId)}`;

export function listGpsProposals(
  projectId: string,
  query: { status?: GpsProposalStatus; cadFileId: string },
): Promise<GpsProposalListResponse> {
  const params = new URLSearchParams({ cadFileId: query.cadFileId });
  if (query.status) params.set('status', query.status);
  return bffJson(`${proposalsPath(projectId)}?${params.toString()}`, GpsProposalListResponseSchema);
}

/** The photo is a same-origin image through the proxy (cookies carry the session). */
export function gpsProposalPhotoUrl(projectId: string, proposalId: string): string {
  return `${onePath(projectId, proposalId)}/photo`;
}

export function acceptGpsProposal(
  projectId: string,
  proposalId: string,
  mappingVersion: number,
): Promise<GpsProposal> {
  return bffJson(`${onePath(projectId, proposalId)}/accept`, GpsProposalSchema, {
    method: 'POST',
    body: { mappingVersion },
  });
}

export function rejectGpsProposal(
  projectId: string,
  proposalId: string,
  reason: string,
): Promise<GpsProposal> {
  return bffJson(`${onePath(projectId, proposalId)}/reject`, GpsProposalSchema, {
    method: 'POST',
    body: { reason },
  });
}
