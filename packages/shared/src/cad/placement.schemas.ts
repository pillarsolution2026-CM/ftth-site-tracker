import { z } from 'zod';
import { PointFeatureTypeSchema } from '../design/feature-types.js';

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

/**
 * typed = Lat/Lon entered by a user; kml = a KML/KMZ placemark; gps = a supervisor's GPS fix;
 * general_cabinet = a Secondary cabinet on the placed position of the General cabinet with the same
 * name (ADR-040 Q9, ADR-042 part G; Secondary files only, see `placementKindProblems`).
 */
export const CONTROL_POINT_SOURCES = ['typed', 'kml', 'gps', 'general_cabinet'] as const;
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

/**
 * Technical cap. Raised from 50 (ADR-042): a Secondary takes one point per shared sub cabinet and
 * a General may have more than 50 (Rabaa: 81).
 */
export const MAX_CONTROL_POINTS = 200;

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

// ---------- what the placement screen draws and picks from (ADR-035) ----------

/**
 * A point item of the uploaded file, classified by the file's saved mapping rules as the build
 * does (ADR-037; no built revision needed), at its drawn centre **in drawing units** (the place the
 * build starts from): an insert's drawn centre, a text's position, or the centre of the joint
 * extents of a shape group. A control point picked from this list uses `x`/`y` and `handle`.
 */
export const PLACEMENT_ITEM_MAX_NAMES = 8;

export const PlacementItemSchema = z.object({
  handle: z.string(),
  featureType: PointFeatureTypeSchema,
  /**
   * The item's code when known without a build: an insert attribute or a text item's own text.
   * Codes the build links from nearby texts are not known yet; `names` carries those texts.
   */
  code: z.string().nullable(),
  /**
   * Short texts written around the item in the drawing, nearest first: each text whose nearest
   * item this is, within a few tens of metres (e.g. ["22U", "1-7"] for Rabaa's cabinet 1-7, whose
   * name sits on another layer). A hint for finding and matching the item only; never stored.
   */
  names: z.array(z.string()).max(PLACEMENT_ITEM_MAX_NAMES),
  layer: z.string(),
  x: Finite,
  y: Finite,
});
export type PlacementItem = z.infer<typeof PlacementItemSchema>;

/** A route line in drawing units, simplified for the preview: [[x, y], …]. */
export const PlacementLineSchema = z.array(z.tuple([Finite, Finite])).min(2);
export type PlacementLine = z.infer<typeof PlacementLineSchema>;

export const PLACEMENT_DRAWING_MAX_LINES = 5000;

export const PlacementDrawingSchema = z.object({
  /**
   * Version of the saved mapping whose rules classified the items (ADR-037); null when no mapping
   * is saved yet (then `items` and `lines` are empty: save the rules first).
   */
  mappingVersion: z.number().int().min(1).nullable(),
  items: z.array(PlacementItemSchema),
  lines: z.array(PlacementLineSchema),
  /** More route lines exist than `PLACEMENT_DRAWING_MAX_LINES`; the preview shows the first ones. */
  truncated: z.boolean(),
});
export type PlacementDrawing = z.infer<typeof PlacementDrawingSchema>;
