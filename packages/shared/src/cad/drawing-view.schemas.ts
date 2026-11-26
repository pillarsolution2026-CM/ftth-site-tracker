import { z } from 'zod';

/**
 * «عارض الرسومات» — the drawing viewer (ADR-039). The drawing exactly as drawn, for the canvas on
 * the design revision page: every model-space entity flattened by the worker (blocks exploded,
 * arcs / circles / splines / hatch outlines turned into polylines, texts kept as texts), grouped by
 * the TOP-LEVEL entity handle so a problem place (insert, text or curve handle) finds its shape.
 * Coordinates are DRAWING units (as problem places' `drawingX/Y` and corrections).
 * Built once per CAD file by the worker job `cad.render_view` and stored as gzip JSON.
 */

export const DRAWING_VIEW_VERSION = 1;

/** Technical caps of the view file, not business rules (security review of ADR-039). */
export const DRAWING_VIEW_MAX_VERTICES = 3_000_000;
export const DRAWING_VIEW_MAX_TEXTS = 200_000;
/** Characters kept of one text; longer texts are cut by the worker. */
export const DRAWING_VIEW_MAX_TEXT_LENGTH = 2000;
/** Uncompressed JSON size the worker refuses above (`TOO_LARGE`). */
export const DRAWING_VIEW_MAX_JSON_BYTES = 96 * 1024 * 1024;

/** `#rrggbb`. ACI colours are resolved by the worker; BYLAYER entities carry `null`. */
const Hex = z.string().regex(/^#[0-9a-f]{6}$/);
const Finite = z.number().refine(Number.isFinite, 'Must be a finite number');

export const DrawingViewLayerSchema = z.object({
  name: z.string().max(255),
  color: Hex,
  /** Off or frozen in the drawing: hidden at first, the user can switch it on. */
  visible: z.boolean(),
});
export type DrawingViewLayer = z.infer<typeof DrawingViewLayerSchema>;

export const DrawingViewTextSchema = z.object({
  x: Finite,
  y: Finite,
  /** Height in drawing units. */
  height: Finite,
  /** Degrees, counter-clockwise. */
  rotation: Finite,
  text: z.string().max(DRAWING_VIEW_MAX_TEXT_LENGTH),
});
export type DrawingViewText = z.infer<typeof DrawingViewTextSchema>;

/** Block names are DXF names (at most 255 characters). */
export const DRAWING_VIEW_MAX_BLOCK_NAME = 255;

export const DrawingViewInsertSchema = z.object({
  x: Finite,
  y: Finite,
  rotation: Finite,
  scaleX: Finite,
  scaleY: Finite,
  name: z.string().max(DRAWING_VIEW_MAX_BLOCK_NAME),
});
export type DrawingViewInsert = z.infer<typeof DrawingViewInsertSchema>;

/** Real vertices kept per polyline (more: the view sends none, grips stay on the path). */
export const DRAWING_VIEW_MAX_ENTITY_VERTICES = 2000;
/** |bulge| kept (as MAX_CURVE_BULGE of the corrections). */
export const DRAWING_VIEW_MAX_BULGE = 1000;

/** A polyline vertex: the bulge goes from this vertex to the next (DXF; > 0 counter-clockwise). */
export const DrawingViewVertexSchema = z.object({
  x: Finite,
  y: Finite,
  bulge: Finite.refine((b) => Math.abs(b) <= DRAWING_VIEW_MAX_BULGE, 'Bulge out of range'),
});
export type DrawingViewVertex = z.infer<typeof DrawingViewVertexSchema>;

/** A circle / arc: centre, radius, counter-clockwise from `start` to `end` degrees (circle 0 → 360). */
export const DrawingViewArcSchema = z.object({
  x: Finite,
  y: Finite,
  r: Finite.refine((r) => r > 0, 'Radius must be positive'),
  start: Finite,
  end: Finite,
});
export type DrawingViewArc = z.infer<typeof DrawingViewArcSchema>;

/**
 * An ellipse: centre, the major axis end point relative to the centre, minor / major ratio, and
 * the start / end parameters in radians (0 → 2π = a full ellipse), as DXF keeps it.
 */
export const DrawingViewEllipseSchema = z.object({
  x: Finite,
  y: Finite,
  majorX: Finite,
  majorY: Finite,
  ratio: Finite.refine((r) => r > 0 && r <= 1, 'Ratio must be in (0, 1]'),
  start: Finite,
  end: Finite,
});
export type DrawingViewEllipse = z.infer<typeof DrawingViewEllipseSchema>;

export const DrawingViewEntitySchema = z.object({
  /** Top-level handle in model space (an INSERT keeps its own handle for all its block shapes). */
  handle: z.string().min(1).max(64),
  /** Index into `layers` of the top-level entity's layer (what a `move_layer` changes). */
  layer: z.number().int().min(0),
  /** Colour when not BYLAYER; null = the layer's colour. */
  color: Hex.nullable(),
  /** DXF type of the top-level entity, e.g. LINE, LWPOLYLINE, INSERT, TEXT, HATCH. */
  kind: z.string().max(32),
  /** Polylines as flat [x0, y0, x1, y1, …]; each has at least two points. */
  paths: z.array(z.array(Finite).min(4)),
  /** Texts of the entity (a TEXT / MTEXT, or attributes and texts inside a block). */
  texts: z.array(DrawingViewTextSchema),
  /**
   * An INSERT's own placement (AutoCAD's grip and Properties, owner 2026-11-26): the insertion
   * point, rotation (degrees, counter-clockwise), X / Y scale and the block name. Absent in views
   * rendered before it was added, and for other entities.
   */
  insert: DrawingViewInsertSchema.optional(),
  /**
   * ADR-062 (owner item 33): a 2D LWPOLYLINE / POLYLINE's real vertices with their bulges, and
   * whether it is closed, so the grips sit on the vertices and arc midpoints, not on every
   * flattened point. `paths[0]` stays its flattened outline. Absent in views rendered before, for
   * other entities and for polylines of more than DRAWING_VIEW_MAX_ENTITY_VERTICES vertices.
   */
  vertices: z
    .array(DrawingViewVertexSchema)
    .min(2)
    .max(DRAWING_VIEW_MAX_ENTITY_VERTICES)
    .optional(),
  closed: z.boolean().optional(),
  /** ADR-062: a CIRCLE's / ARC's own centre, radius and angles (WCS). Absent before. */
  arc: DrawingViewArcSchema.optional(),
  /** ADR-062: an ELLIPSE's own parameters (WCS). Absent before. */
  ellipse: DrawingViewEllipseSchema.optional(),
});
export type DrawingViewEntity = z.infer<typeof DrawingViewEntitySchema>;

export const DrawingViewSchema = z.object({
  version: z.literal(DRAWING_VIEW_VERSION),
  cadFileId: z.uuid(),
  extents: z.object({ minX: Finite, minY: Finite, maxX: Finite, maxY: Finite }),
  layers: z.array(DrawingViewLayerSchema),
  entities: z.array(DrawingViewEntitySchema),
  /** Vertices were capped (`DRAWING_VIEW_MAX_VERTICES`): some shapes are simplified or missing. */
  truncated: z.boolean(),
});
export type DrawingView = z.infer<typeof DrawingViewSchema>;

export const DRAWING_VIEW_STATUSES = ['none', 'queued', 'ready', 'failed'] as const;
export const DrawingViewStatusSchema = z.enum(DRAWING_VIEW_STATUSES);
export type DrawingViewStatus = z.infer<typeof DrawingViewStatusSchema>;

/**
 * GET /projects/:p/cad-files/:f/view/status — and POST …/view to (re)request it.
 * A processed file without a view gets one queued by POST; GET …/view returns the gzip JSON
 * (`DrawingView`) when `ready`, else 404.
 */
export const DrawingViewStateSchema = z.object({
  cadFileId: z.uuid(),
  status: DrawingViewStatusSchema,
  /** Present when failed. */
  errorCode: z.string().nullable(),
  /** Size of the stored gzip file when ready. */
  sizeBytes: z.number().int().min(0).nullable(),
  renderedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type DrawingViewState = z.infer<typeof DrawingViewStateSchema>;
