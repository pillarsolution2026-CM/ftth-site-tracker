import { z } from 'zod';
import { DrawingUnitSchema } from './drawing-units.js';

/**
 * Coordinate systems a design revision may use: WGS 84 / UTM north (326zz) and south (327zz).
 * Same limit as `@ftth/geo` (decision G-*); other EPSG codes are rejected until a project needs them.
 */
export function isSupportedProjectEpsg(epsg: number): boolean {
  return (
    Number.isInteger(epsg) && ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760))
  );
}

export const ProjectEpsgSchema = z
  .number()
  .int()
  .refine(isSupportedProjectEpsg, 'Only WGS 84 / UTM (EPSG 32601-32660, 32701-32760)');

/**
 * Result of the worker's CRS detection from the drawing extents (computed at import, stored on
 * `cad_files.crs_detection`). The PM confirms the EPSG on the mapping screen; nothing is applied
 * automatically.
 *
 * - `projected_utm`: extents fit UTM easting/northing ranges when read as metres.
 *   `suggestedEpsg` is set only when the project's own UTM CRS places the drawing inside its zone
 *   (easting alone cannot tell the zone).
 * - `geographic`: values look like longitude/latitude degrees (not metric; not supported for revisions).
 * - `local`: small coordinates around an arbitrary origin (needs georeferencing, out of scope v1).
 * - `unknown`: none of the above, or no extents.
 */
export const CRS_DETECTION_KINDS = ['projected_utm', 'geographic', 'local', 'unknown'] as const;
export const CrsDetectionKindSchema = z.enum(CRS_DETECTION_KINDS);
export type CrsDetectionKind = z.infer<typeof CrsDetectionKindSchema>;

export const CRS_DETECTION_REASONS = [
  /** UTM-like extents fall inside the project's UTM zone. */
  'MATCHES_PROJECT_CRS',
  /** UTM-like extents, but the project CRS is not UTM or the drawing falls outside its zone. */
  'UTM_ZONE_UNKNOWN',
  'LONLAT_RANGE',
  'SMALL_LOCAL_COORDINATES',
  'NO_EXTENTS',
  'OUT_OF_KNOWN_RANGES',
] as const;
export const CrsDetectionReasonSchema = z.enum(CRS_DETECTION_REASONS);
export type CrsDetectionReason = z.infer<typeof CrsDetectionReasonSchema>;

export const CrsDetectionSchema = z.object({
  kind: CrsDetectionKindSchema,
  reason: CrsDetectionReasonSchema,
  suggestedEpsg: z.number().int().nullable(),
  /** The project's CRS at detection time. */
  projectEpsg: z.number().int().nullable(),
  /** Unit under which the extents fit the detected CRS (UTM = metres); null when not applicable. */
  impliedUnit: DrawingUnitSchema.nullable(),
  /** Raw DXF `$INSUNITS`. */
  insUnits: z.number().int().nullable(),
  /** Unit declared by `$INSUNITS` (null when unitless or unsupported). */
  declaredUnit: DrawingUnitSchema.nullable(),
  /**
   * True when `$INSUNITS` declares a unit different from `impliedUnit` (Qalyub: inches vs metres
   * on UTM 36N). The mapping screen shows a warning; the PM's chosen drawing unit decides.
   */
  unitsConflict: z.boolean(),
});
export type CrsDetection = z.infer<typeof CrsDetectionSchema>;
