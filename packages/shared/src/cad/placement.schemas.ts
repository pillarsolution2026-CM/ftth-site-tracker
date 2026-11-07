import { z } from 'zod';

/**
 * Where a drawing sits on the earth (ADR-032, ADR-035). Stored with the mapping and frozen on the
 * design revision; the drawing file never changes. Applied at build, in this order:
 *   drawing units → metres (the revision's unit factor)
 *   → source CRS → project UTM (`egypt_red_belt`: Egypt 1907 / Red Belt, general parameters)
 *   → control-point fit (1 point shift, 2 shift + rotation, 3+ best fit with scale)
 *   → hand adjustment (Move / Rotate / Scale about `adjust.pivot`).
 * Solved by `solvePlacement` in `@ftth/geo`, mirrored by `workers/cad/cad_worker/domain/placement.py`.
 */
export const PLACEMENT_SOURCE_CRS = ['project', 'egypt_red_belt'] as const;
export const PlacementSourceCrsSchema = z.enum(PLACEMENT_SOURCE_CRS);
export type PlacementSourceCrs = z.infer<typeof PlacementSourceCrsSchema>;

/**
 * Egypt 1907 / Red Belt (EPSG 22992) with the published general datum shift (ADR-035: no local
 * parameters are sought; control points remove the remaining few metres). Mirrored by the worker.
 */
export const EGYPT_RED_BELT_PROJ4 =
  '+proj=tmerc +lat_0=30 +lon_0=31 +k=1 +x_0=615000 +y_0=810000 +ellps=helmert ' +
  '+towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs';

/** typed = Lat/Lon entered by a user; kml = a KML/KMZ placemark; gps = a supervisor's GPS fix. */
export const CONTROL_POINT_SOURCES = ['typed', 'kml', 'gps'] as const;
export const ControlPointSourceSchema = z.enum(CONTROL_POINT_SOURCES);
export type ControlPointSource = z.infer<typeof ControlPointSourceSchema>;

const Finite = z.number().refine(Number.isFinite, 'Must be a finite number');

export const ControlPointSchema = z.object({
  id: z.string().min(1).max(64),
  /** The point on the drawing, in drawing units (an item's drawn centre, or a clicked point). */
  drawing: z.object({ x: Finite, y: Finite }),
  /** The drawing item it was taken from, when it was picked from the list. */
  handle: z.string().min(1).max(64).nullable().default(null),
  /** Shown to people: the item's code / label or the placemark's name. */
  label: z.string().max(200).nullable().default(null),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  source: ControlPointSourceSchema,
  /** Left out of the fit (e.g. a placemark far from the others); its error is still shown. */
  excluded: z.boolean().default(false),
});
export type ControlPoint = z.infer<typeof ControlPointSchema>;

/** Hand adjustment after the points (ADR-035: Move / Rotate / Scale, as in CAD-Earth). */
export const PlacementAdjustSchema = z.object({
  /** Metres, project CRS. */
  dx: Finite.default(0),
  dy: Finite.default(0),
  /** Degrees, counter-clockwise. */
  rotationDeg: z.number().min(-180).max(180).default(0),
  scale: z.number().min(0.5).max(2).default(1),
  /** Rotation and scale turn about this point (project CRS); required when they are not neutral. */
  pivot: z.object({ x: Finite, y: Finite }).nullable().default(null),
});
export type PlacementAdjust = z.infer<typeof PlacementAdjustSchema>;

export const MAX_CONTROL_POINTS = 50;

export const PlacementSchema = z
  .object({
    sourceCrs: PlacementSourceCrsSchema.default('project'),
    points: z.array(ControlPointSchema).max(MAX_CONTROL_POINTS).default([]),
    /** Two points fix rotation; scale is fitted from two points only when asked (ADR-032). */
    fitScaleWithTwoPoints: z.boolean().default(false),
    adjust: PlacementAdjustSchema.default({
      dx: 0,
      dy: 0,
      rotationDeg: 0,
      scale: 1,
      pivot: null,
    }),
  })
  .superRefine((p, ctx) => {
    const turns = p.adjust.rotationDeg !== 0 || p.adjust.scale !== 1;
    if (turns && p.adjust.pivot === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['adjust', 'pivot'],
        message: 'Rotate / Scale need a pivot',
      });
    }
    const ids = new Set<string>();
    p.points.forEach((point, index) => {
      if (ids.has(point.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['points', index, 'id'],
          message: 'Duplicate point id',
        });
      }
      ids.add(point.id);
    });
  });
export type Placement = z.infer<typeof PlacementSchema>;

/** Scale changes further than this from 1 are warned before saving (ADR-032). */
export const PLACEMENT_SCALE_WARNING = 0.001;
