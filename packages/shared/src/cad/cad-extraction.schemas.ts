import { z } from 'zod';
import { BooleanQuerySchema, PageQuerySchema, pageSchema } from '../common/pagination.js';

/**
 * Raw extraction read models for the review screens (Phase 1a). Coordinates are drawing units
 * (SRID 0) and are NOT the project CRS until the CRS is confirmed in Phase 1b.
 * Only model-space entities are extracted; block contents are represented by their inserts.
 */

/** ACI colour: 0 = BYBLOCK, 1..255 = palette, 256 = BYLAYER. */
const AciColorSchema = z.number().int().min(0).max(256);
/** 24-bit true colour (0xRRGGBB) when set. */
const TrueColorSchema = z.number().int().min(0).max(0xffffff).nullable();

export const PointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const CadLayerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Layer colour, 1..255 (a negative DXF colour means "off" and is reported via isOn). */
  aciColor: z.number().int().min(1).max(255),
  trueColor: TrueColorSchema,
  linetype: z.string().nullable(),
  isOn: z.boolean(),
  isFrozen: z.boolean(),
  isLocked: z.boolean(),
  /** Model-space entity counts by DXF type, e.g. { "LWPOLYLINE": 120, "INSERT": 17 }. */
  entityCounts: z.record(z.string(), z.number().int().min(0)),
  entityTotal: z.number().int().min(0),
});
export type CadLayer = z.infer<typeof CadLayerSchema>;

export const CadLayerListResponseSchema = z.object({ items: z.array(CadLayerSchema) });
export type CadLayerListResponse = z.infer<typeof CadLayerListResponseSchema>;

export const CadInsertAttributeSchema = z.object({
  tag: z.string(),
  /** Value exactly as stored in the DXF. */
  rawValue: z.string(),
  /** Decoded value (MTEXT codes stripped, SHX/codepage decoded); equals rawValue if nothing to do. */
  value: z.string(),
  readable: z.boolean(),
});
export type CadInsertAttribute = z.infer<typeof CadInsertAttributeSchema>;

export const CadInsertSchema = z.object({
  id: z.uuid(),
  /** DXF entity handle (stable within one file). */
  handle: z.string(),
  layer: z.string(),
  blockName: z.string(),
  position: PointSchema,
  /** Degrees, counter-clockwise. */
  rotation: z.number(),
  scale: PointSchema,
  aciColor: AciColorSchema,
  attributes: z.array(CadInsertAttributeSchema),
});
export type CadInsert = z.infer<typeof CadInsertSchema>;

export const CAD_TEXT_KINDS = ['text', 'mtext'] as const;
export const CadTextKindSchema = z.enum(CAD_TEXT_KINDS);
export type CadTextKind = z.infer<typeof CadTextKindSchema>;

export const CadTextSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  kind: CadTextKindSchema,
  layer: z.string(),
  /** Insertion point. */
  position: PointSchema,
  height: z.number(),
  /** Degrees, counter-clockwise. */
  rotation: z.number(),
  /** Text exactly as stored in the DXF (MTEXT format codes included). */
  rawText: z.string(),
  /** Decoded plain text. */
  text: z.string(),
  /** False when decoding is uncertain (e.g. unknown SHX font); such texts go to review. */
  readable: z.boolean(),
  style: z.string().nullable(),
  /** Font file of the style, e.g. "xarb.shx", "arial.ttf". */
  font: z.string().nullable(),
  aciColor: AciColorSchema,
});
export type CadText = z.infer<typeof CadTextSchema>;

export const CAD_CURVE_ENTITY_TYPES = [
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'ARC',
  'CIRCLE',
  'SPLINE',
] as const;
export const CadCurveEntityTypeSchema = z.enum(CAD_CURVE_ENTITY_TYPES);
export type CadCurveEntityType = z.infer<typeof CadCurveEntityTypeSchema>;

/** List-screen summary of a curve; full geometry is served later as tiles/GeoJSON. */
export const CadCurveSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  entityType: CadCurveEntityTypeSchema,
  layer: z.string(),
  vertexCount: z.number().int().min(2),
  isClosed: z.boolean(),
  /** 2D length in drawing units (ST_Length on SRID 0). */
  length: z.number().min(0),
  bbox: z.object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() }),
  /** True when arcs/bulges/splines were flattened into vertices. */
  approximated: z.boolean(),
  aciColor: AciColorSchema,
});
export type CadCurve = z.infer<typeof CadCurveSchema>;

// ---------- list queries ----------

const LayerFilter = z.string().min(1).max(255).optional();

export const CadInsertListQuerySchema = PageQuerySchema.extend({
  layer: LayerFilter,
  blockName: z.string().min(1).max(255).optional(),
});
export type CadInsertListQuery = z.infer<typeof CadInsertListQuerySchema>;

export const CadTextListQuerySchema = PageQuerySchema.extend({
  layer: LayerFilter,
  kind: CadTextKindSchema.optional(),
  readable: BooleanQuerySchema.optional(),
  /** Case-insensitive substring match on decoded text. */
  q: z.string().min(1).max(200).optional(),
});
export type CadTextListQuery = z.infer<typeof CadTextListQuerySchema>;

export const CadCurveListQuerySchema = PageQuerySchema.extend({
  layer: LayerFilter,
  entityType: CadCurveEntityTypeSchema.optional(),
});
export type CadCurveListQuery = z.infer<typeof CadCurveListQuerySchema>;

export const CadInsertPageSchema = pageSchema(CadInsertSchema);
export type CadInsertPage = z.infer<typeof CadInsertPageSchema>;
export const CadTextPageSchema = pageSchema(CadTextSchema);
export type CadTextPage = z.infer<typeof CadTextPageSchema>;
export const CadCurvePageSchema = pageSchema(CadCurveSchema);
export type CadCurvePage = z.infer<typeof CadCurvePageSchema>;
