import { sql, type SQL } from 'drizzle-orm';
import type { GpsProposalListQuery } from '@ftth/shared';
import type { DbHandle } from '../../../db/db.module.js';
import { rowsOf } from '../../../db/sql.js';
import type {
  GpsProposalDecision,
  GpsProposalRecord,
  GpsProposalRepository,
} from '../domain/gps-proposal.js';

interface Row {
  id: string;
  project_id: string;
  design_revision_id: string;
  rev_no: number;
  cad_file_id: string;
  feature_id: string;
  feature_type: GpsProposalRecord['featureType'];
  code: string | null;
  handle: string;
  lat: number;
  lon: number;
  accuracy_m: number;
  fix_at: Date;
  received_at: Date;
  proposed_by: string;
  proposed_by_name: string;
  note: string | null;
  photo_id: string | null;
  photo_stored: boolean | null;
  status: GpsProposalRecord['status'];
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  reject_reason: string | null;
  accepted_mapping_version: number | null;
}

const toRecord = (row: Row): GpsProposalRecord => ({
  id: row.id,
  projectId: row.project_id,
  designRevisionId: row.design_revision_id,
  revNo: row.rev_no,
  cadFileId: row.cad_file_id,
  featureId: row.feature_id,
  featureType: row.feature_type,
  code: row.code,
  handle: row.handle,
  lat: Number(row.lat),
  lon: Number(row.lon),
  accuracyM: Number(row.accuracy_m),
  fixAt: new Date(row.fix_at),
  receivedAt: new Date(row.received_at),
  proposedBy: { id: row.proposed_by, name: row.proposed_by_name },
  note: row.note,
  photo: row.photo_id ? { id: row.photo_id, stored: row.photo_stored === true } : null,
  status: row.status,
  decidedBy: row.decided_by ? { id: row.decided_by, name: row.decided_by_name ?? '' } : null,
  decidedAt: row.decided_at ? new Date(row.decided_at) : null,
  rejectReason: row.reject_reason,
  acceptedMappingVersion: row.accepted_mapping_version,
});

const SELECT = sql`
  SELECT g.id, g.project_id, g.design_revision_id, r.rev_no, g.cad_file_id, g.feature_id,
         g.feature_type, g.code, g.handle, ST_Y(g.fix) AS lat, ST_X(g.fix) AS lon, g.accuracy_m,
         g.fix_at, g.received_at, g.proposed_by, pu.display_name AS proposed_by_name, g.note,
         ph.id AS photo_id, (ph.stored_at IS NOT NULL) AS photo_stored,
         g.status, g.decided_by, du.display_name AS decided_by_name, g.decided_at,
         g.reject_reason, g.accepted_mapping_version
  FROM gps_point_proposals g
  JOIN design_revisions r ON r.project_id = g.project_id AND r.id = g.design_revision_id
  JOIN users pu ON pu.id = g.proposed_by
  LEFT JOIN users du ON du.id = g.decided_by
  LEFT JOIN execution_photos ph ON ph.project_id = g.project_id AND ph.proposal_id = g.id`;

/** Newest proposals returned by one list call (security review M2); technical cap, not a rule. */
export const GPS_PROPOSAL_LIST_LIMIT = 200;

export class DrizzleGpsProposalRepository implements GpsProposalRepository {
  constructor(private readonly db: DbHandle) {}

  async list(projectId: string, query: GpsProposalListQuery): Promise<GpsProposalRecord[]> {
    const filters: SQL[] = [sql`g.project_id = ${projectId}`];
    if (query.status) filters.push(sql`g.status = ${query.status}`);
    if (query.cadFileId) filters.push(sql`g.cad_file_id = ${query.cadFileId}`);
    const rows = await rowsOf<Row>(
      this.db,
      sql`${SELECT} WHERE ${sql.join(filters, sql` AND `)}
          ORDER BY g.received_at DESC, g.id DESC
          LIMIT ${GPS_PROPOSAL_LIST_LIMIT}`,
    );
    return rows.map(toRecord);
  }

  async find(
    projectId: string,
    proposalId: string,
    options?: { lock?: boolean },
  ): Promise<GpsProposalRecord | null> {
    const [row] = await rowsOf<Row>(
      this.db,
      sql`${SELECT} WHERE g.project_id = ${projectId} AND g.id = ${proposalId}
          ${options?.lock ? sql`FOR UPDATE OF g` : sql``}`,
    );
    return row ? toRecord(row) : null;
  }

  async photo(
    projectId: string,
    proposalId: string,
  ): Promise<{ storageKey: string | null } | null> {
    const [row] = await rowsOf<{ storage_key: string | null }>(
      this.db,
      sql`SELECT storage_key FROM execution_photos
          WHERE project_id = ${projectId} AND proposal_id = ${proposalId}`,
    );
    return row ? { storageKey: row.storage_key } : null;
  }

  async drawnCentre(
    projectId: string,
    proposal: Pick<GpsProposalRecord, 'designRevisionId' | 'featureId' | 'cadFileId'>,
  ): Promise<{ x: number; y: number } | null> {
    // As the build starts from it (ADR-032/035): an insert's drawn centre (else its position), a
    // text's position, or the centre of the joint extents of a shape group (`attrs.shapes`, else
    // the source curve).
    const [row] = await rowsOf<{ x: number | null; y: number | null }>(
      this.db,
      sql`SELECT CASE df.source_kind WHEN 'insert' THEN ST_X(COALESCE(ci.centre, ci.position))
                                     WHEN 'text' THEN ST_X(ct.position)
                                     ELSE (ST_XMin(sh.box) + ST_XMax(sh.box)) / 2 END AS x,
                 CASE df.source_kind WHEN 'insert' THEN ST_Y(COALESCE(ci.centre, ci.position))
                                     WHEN 'text' THEN ST_Y(ct.position)
                                     ELSE (ST_YMin(sh.box) + ST_YMax(sh.box)) / 2 END AS y
          FROM design_features df
          LEFT JOIN cad_inserts ci
            ON df.source_kind = 'insert' AND ci.cad_file_id = ${proposal.cadFileId}
           AND ci.handle = df.source_handle
          LEFT JOIN cad_texts ct
            ON df.source_kind = 'text' AND ct.cad_file_id = ${proposal.cadFileId}
           AND ct.handle = df.source_handle
          LEFT JOIN LATERAL (
            SELECT ST_Extent(cc.geom) AS box FROM cad_curves cc
            WHERE df.source_kind = 'curve' AND cc.cad_file_id = ${proposal.cadFileId}
              AND cc.handle = ANY (
                CASE WHEN jsonb_typeof(df.attrs -> 'shapes') = 'array'
                     THEN ARRAY(SELECT jsonb_array_elements_text(df.attrs -> 'shapes'))
                     ELSE ARRAY[df.source_handle] END)
          ) sh ON true
          WHERE df.project_id = ${projectId} AND df.revision_id = ${proposal.designRevisionId}
            AND df.feature_id = ${proposal.featureId}`,
    );
    if (!row || row.x === null || row.y === null) return null;
    return { x: Number(row.x), y: Number(row.y) };
  }

  async decide(
    projectId: string,
    proposalId: string,
    decision: GpsProposalDecision,
  ): Promise<boolean> {
    const rows = await rowsOf(
      this.db,
      sql`UPDATE gps_point_proposals
          SET status = ${decision.status}, decided_by = ${decision.decidedBy},
              decided_at = ${decision.decidedAt.toISOString()},
              reject_reason = ${decision.status === 'rejected' ? decision.reason : null},
              accepted_mapping_version =
                ${decision.status === 'accepted' ? decision.mappingVersion : null}::integer
          WHERE project_id = ${projectId} AND id = ${proposalId} AND status = 'pending'
          RETURNING id`,
    );
    return rows.length > 0;
  }
}
