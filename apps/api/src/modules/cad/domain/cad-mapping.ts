import type { DrawingUnit, MappingRule } from '@ftth/shared';

/** The editable mapping of one CAD file (ADR-017). Revisions keep their own frozen copy. */
export interface CadMappingRecord {
  cadFileId: string;
  projectId: string;
  rules: MappingRule[];
  crsEpsg: number;
  drawingUnit: DrawingUnit;
  /** Exact decimal string from METRES_PER_UNIT, e.g. "0.0254". */
  metresPerUnit: string;
  /** Optimistic concurrency token: 1 on insert, +1 on every update. */
  version: number;
  updatedById: string | null;
  updatedAt: Date;
}
