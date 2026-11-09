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

/** `#rrggbb`. ACI colours are resolved by the worker; BYLAYER entities carry `null`. */
const Hex = z.string().regex(/^#[0-9a-f]{6}$/);
const Finite = z.number().refine(Number.isFinite, 'Must be a finite number');

export const DrawingViewLayerSchema = z.object({
  name: z.string(),
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
  text: z.string(),
});
export type DrawingViewText = z.infer<typeof DrawingViewTextSchema>;

export const DrawingViewEntitySchema = z.object({
  /** Top-level handle in model space (an INSERT keeps its own handle for all its block shapes). */
  handle: z.string(),
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

/** Technical caps of the view file, not business rules. */
export const DRAWING_VIEW_MAX_VERTICES = 3_000_000;
export const DRAWING_VIEW_MAX_TEXTS = 200_000;

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
