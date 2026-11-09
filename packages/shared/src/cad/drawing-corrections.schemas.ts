import { z } from 'zod';
import { FEATURE_TYPES } from '../design/feature-types.js';
import { DrawingProblemCodeSchema } from '../design/drawing-problems.js';
import type { MappingRule } from './cad-mapping.schemas.js';
import { DesignRevisionSummarySchema } from '../design/design-revision.schemas.js';

/**
 * Drawing corrections made on the program page (ADR-038). The drawing file never changes: each
 * correction is stored with the CAD file, applied by the worker to the extracted rows before
 * classification and checks, and frozen on the design revision with the other build inputs.
 * Coordinates are in DRAWING units (as the placement's control points).
 *
 * One tool per problem:
 * - `WRONG_LAYER` → `move_layer` (insert, text or curve to another layer);
 * - `LABEL_MISSING` → `add_text` (a label on the layer of the item's type, next to it);
 * - `LABEL_TYPE_MISMATCH` → `set_text` (edit the label) or `add_item` (an item of the label's type);
 * - `LABEL_LENGTH_MISSING` → `set_text` (write the length into the label);
 * - `ROUTE_SPLIT` → `merge_routes` (pieces meeting end to end become one route).
 * `RING_LABEL_MISMATCH` and a route that needs a new path are fixed in AutoCAD (part 3).
 */

/** |x|, |y| of added texts / items, drawing units (security review: no inf / NaN geometry). */
export const MAX_CORRECTION_COORD = 1_000_000_000;
const Coord = z
  .number()
  .refine(Number.isFinite, 'Must be a finite number')
  .min(-MAX_CORRECTION_COORD)
  .max(MAX_CORRECTION_COORD);
/** No control characters (U+0000–U+001F): Postgres refuses NUL; none belongs in a name or label. */
const noControl = (value: string) => ![...value].some((char) => char.charCodeAt(0) < 0x20);
const Handle = z.string().min(1).max(64).refine(noControl, 'Control characters are not allowed');
const LayerName = z
  .string()
  .min(1)
  .max(255)
  .refine(noControl, 'Control characters are not allowed');
const Text = z.string().trim().min(1).refine(noControl, 'Control characters are not allowed');

export const DRAWING_CORRECTION_KINDS = [
  'move_layer',
  'set_text',
  'add_text',
  'add_item',
  'merge_routes',
] as const;
export const DrawingCorrectionKindSchema = z.enum(DRAWING_CORRECTION_KINDS);
export type DrawingCorrectionKind = z.infer<typeof DrawingCorrectionKindSchema>;

export const MAX_TEXT_LENGTH = 255;
/** Pieces one merge may join; technical cap, not a rule. */
export const MAX_MERGE_PIECES = 50;
export const MAX_CORRECTIONS_PER_FILE = 5000;
/** Rows per file including withdrawn ones (security review: add + withdraw loops stay bounded). */
export const MAX_CORRECTION_ROWS_PER_FILE = 4 * MAX_CORRECTIONS_PER_FILE;

export const DrawingCorrectionInputSchema = z.discriminatedUnion('kind', [
  /** An insert, text or curve moves to another layer (its rule then decides what it is). */
  z.strictObject({
    kind: z.literal('move_layer'),
    handle: Handle,
    toLayer: LayerName,
  }),
  /** A text's content is replaced (readable from now on). */
  z.strictObject({
    kind: z.literal('set_text'),
    handle: Handle,
    text: Text.max(MAX_TEXT_LENGTH),
  }),
  /** A new text, e.g. a missing label next to its item. `height` in drawing units. */
  z.strictObject({
    kind: z.literal('add_text'),
    layer: LayerName,
    x: Coord,
    y: Coord,
    text: Text.max(MAX_TEXT_LENGTH),
    height: z.number().positive().max(1_000_000).nullable().default(null),
  }),
  /**
   * A new point item at a spot, as an insert of no block on `layer`: the layer's rule decides its
   * type (pick a layer mapped to the wanted point type).
   */
  z.strictObject({
    kind: z.literal('add_item'),
    layer: LayerName,
    x: Coord,
    y: Coord,
  }),
  /** Route pieces that meet end to end are joined into one route, keyed by the smallest handle. */
  z.strictObject({
    kind: z.literal('merge_routes'),
    handles: z
      .array(Handle)
      .min(2)
      .max(MAX_MERGE_PIECES)
      .refine((h) => new Set(h).size === h.length, 'Duplicate handle'),
  }),
]);
export type DrawingCorrectionInput = z.infer<typeof DrawingCorrectionInputSchema>;

/** POST /projects/:p/cad-files/:f/corrections — the problem it answers is optional context. */
export const CreateDrawingCorrectionRequestSchema = z.strictObject({
  correction: DrawingCorrectionInputSchema,
  /** The problem place this correction answers (shown in history; not checked). */
  problem: z
    .strictObject({ code: DrawingProblemCodeSchema, handle: Handle })
    .nullable()
    .default(null),
});
export type CreateDrawingCorrectionRequest = z.infer<typeof CreateDrawingCorrectionRequestSchema>;

export const DrawingCorrectionSchema = z.object({
  id: z.uuid(),
  cadFileId: z.uuid(),
  correction: DrawingCorrectionInputSchema,
  problem: z.object({ code: DrawingProblemCodeSchema, handle: Handle }).nullable(),
  createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Withdrawn corrections stay in history and are no longer applied. */
  withdrawnBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  withdrawnAt: z.iso.datetime({ offset: true }).nullable(),
});
export type DrawingCorrection = z.infer<typeof DrawingCorrectionSchema>;

/** GET /projects/:p/cad-files/:f/corrections — newest first, withdrawn ones included. */
export const DrawingCorrectionListSchema = z.object({
  items: z.array(DrawingCorrectionSchema),
  /** Corrections in force (not withdrawn): what the next build applies. */
  activeCount: z.number().int().min(0),
});
export type DrawingCorrectionList = z.infer<typeof DrawingCorrectionListSchema>;

/**
 * Frozen on a design revision at creation (`design_revisions.corrections`, in id order) and read by
 * the worker: only corrections in force, in the order they were made.
 */
export const FrozenDrawingCorrectionSchema = z.object({
  id: z.uuid(),
  correction: DrawingCorrectionInputSchema,
});
export type FrozenDrawingCorrection = z.infer<typeof FrozenDrawingCorrectionSchema>;

/**
 * POST /projects/:p/design-revisions/:r/rebuild — «طبّق التصليحات وابنِ من جديد». Discards the draft
 * `r` and creates a new revision of the same file with the current mapping and corrections, in one
 * step (the one-draft rule otherwise forces discard then build). `mappingVersion` as in create.
 * Answer: the new revision (202), as `POST /design-revisions`.
 */
export const RebuildDesignRevisionRequestSchema = z.strictObject({
  mappingVersion: z.number().int().min(1),
});
export type RebuildDesignRevisionRequest = z.infer<typeof RebuildDesignRevisionRequestSchema>;
export const RebuildDesignRevisionResponseSchema = DesignRevisionSummarySchema;

/**
 * Layers a `move_layer` may target (owner 2026-11-09): only a layer whose mapping rule makes it a
 * feature type or a label. A layer without a rule, or with `ignore` / `background`, would drop the
 * item before the checks and hide its error, which ADR-038 forbids. Same rule in the API (at add)
 * and the worker (at build, with the frozen rules).
 */
export const MOVE_LAYER_TARGETS: readonly string[] = [...FEATURE_TYPES, 'label'];

export function moveLayerTargets(rules: readonly MappingRule[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.source === 'layer' && MOVE_LAYER_TARGETS.includes(rule.target)) out.add(rule.layer);
  }
  return out;
}
