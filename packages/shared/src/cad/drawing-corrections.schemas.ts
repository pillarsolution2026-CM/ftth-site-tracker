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
 * - `LABEL_TYPE_MISMATCH` → `set_text` (edit the label), `add_item` (an item of the label's type)
 *   or `move_layer` of the item (the label is right, the item is on the wrong layer; ADR-046);
 * - `LABEL_LENGTH_MISSING` → `set_text` (write the length into the label);
 * - `ROUTE_SPLIT` → `merge_routes` (pieces meeting end to end become one route).
 * `RING_LABEL_MISMATCH` and a route that needs a new path are fixed in AutoCAD (part 3).
 * Any problem place the build misread can be dismissed by a PM with a reason (`dismiss_problem`,
 * ADR-046): it no longer counts at the next build, so it no longer blocks publishing.
 * The edit mode of the drawing (ADR-047) also moves (`move_item`) and rotates (`rotate_item`)
 * an insert, text or curve.
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
  'dismiss_problem',
  'move_item',
  'rotate_item',
  'erase_item',
  'copy_item',
  'mirror_item',
  'scale_item',
  'add_curve',
  'add_layer',
  'rename_layer',
  'delete_layer',
  'set_curve',
  'add_note',
  'set_style',
  'add_shape',
  'set_order',
] as const;
export const DrawingCorrectionKindSchema = z.enum(DRAWING_CORRECTION_KINDS);
export type DrawingCorrectionKind = z.infer<typeof DrawingCorrectionKindSchema>;

export const MAX_TEXT_LENGTH = 255;
export const MAX_DISMISS_REASON_LENGTH = 255;
/** Pieces one merge may join; technical cap, not a rule. */
export const MAX_MERGE_PIECES = 50;
export const MAX_CORRECTIONS_PER_FILE = 5000;
/** Rows per file including withdrawn ones (security review: add + withdraw loops stay bounded). */
export const MAX_CORRECTION_ROWS_PER_FILE = 4 * MAX_CORRECTIONS_PER_FILE;
/** A rotation in degrees, counter-clockwise as in CAD; one turn at most either way. */
export const MAX_ROTATION_DEG = 360;
/** A scale factor of `scale_item` (technical bounds, not a rule). */
export const MIN_SCALE_FACTOR = 0.001;
export const MAX_SCALE_FACTOR = 1000;
/** Points of one drawn line or polyline (`add_curve`). */
export const MAX_CURVE_POINTS = 2000;
/** Points of one dimension or leader note (`add_note`, ADR-051). */
export const MAX_NOTE_POINTS = 50;
/** A line weight of `set_style`, millimetres as in CAD (technical bound, not a rule). */
export const MAX_LINEWEIGHT_MM = 10;
/** Notes the drawing screen saves and draws, ignored by the build (ADR-051). */
export const DRAWING_NOTE_KINDS = ['dimension', 'leader'] as const;
export const DrawingNoteKindSchema = z.enum(DRAWING_NOTE_KINDS);
export type DrawingNoteKind = z.infer<typeof DrawingNoteKindSchema>;
export const DRAWING_LINETYPES = ['continuous', 'dashed', 'dotted', 'center'] as const;
export const DrawingLinetypeSchema = z.enum(DRAWING_LINETYPES);
export type DrawingLinetype = z.infer<typeof DrawingLinetypeSchema>;
/** Corrections the build ignores: only the drawing screen reads them (ADR-051). */
export const SCREEN_ONLY_CORRECTION_KINDS: readonly DrawingCorrectionKind[] = [
  'add_note',
  'set_style',
  'add_shape',
  'set_order',
];
/**
 * Shapes the drawing screen saves and draws, ignored by the build (owner 2026-11-24): a hatch or
 * gradient inside a closed boundary, a wipeout (an area painted with the background), a donut
 * (a ring, or a dot when `inner` is 0), and the construction lines XLINE (both ways) and RAY.
 */
export const DRAWING_SHAPE_KINDS = [
  'hatch',
  'gradient',
  'wipeout',
  'donut',
  'xline',
  'ray',
] as const;
export const DrawingShapeKindSchema = z.enum(DRAWING_SHAPE_KINDS);
export type DrawingShapeKind = z.infer<typeof DrawingShapeKindSchema>;
/** Hatch patterns of the screen (in the spirit of AutoCAD's SOLID, ANSI31, ANSI37 and DOTS). */
export const HATCH_PATTERNS = ['SOLID', 'ANSI31', 'ANSI37', 'DOTS'] as const;
export const HatchPatternSchema = z.enum(HATCH_PATTERNS);
export type HatchPattern = z.infer<typeof HatchPatternSchema>;
/** A draw order key of `set_order` (technical bound): a higher one is drawn later, on top. */
export const MAX_DRAW_ORDER = 1_000_000_000;
const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #rrggbb');
const Point = z.tuple([Coord, Coord]);
const Size = z.number().refine(Number.isFinite).min(0).max(MAX_CORRECTION_COORD);

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
  /**
   * A problem place the build misread is dismissed (ADR-046): the next build drops that place
   * (`code` + `handle`, as the problem list gives it, cut to 64 characters) from the problems.
   * Recorded with who, when and why; withdrawable like any correction.
   */
  z.strictObject({
    kind: z.literal('dismiss_problem'),
    code: DrawingProblemCodeSchema,
    handle: Handle,
    reason: Text.max(MAX_DISMISS_REASON_LENGTH),
  }),
  /**
   * An insert, text or curve is moved by (dx, dy) drawing units (ADR-047): an insert's or text's
   * point, every point of a curve.
   */
  z.strictObject({
    kind: z.literal('move_item'),
    handle: Handle,
    dx: Coord,
    dy: Coord,
  }),
  /**
   * An insert, text or curve is turned by `angle` degrees (counter-clockwise) about (x, y)
   * (ADR-047). The build reads points: an insert's or text's point turns about (x, y), and so do
   * the points of a curve.
   */
  z.strictObject({
    kind: z.literal('rotate_item'),
    handle: Handle,
    x: Coord,
    y: Coord,
    angle: z
      .number()
      .refine(Number.isFinite, 'Must be a finite number')
      .min(-MAX_ROTATION_DEG)
      .max(MAX_ROTATION_DEG),
  }),
  /** The CAD ribbon (ADR-050): an insert, text or curve is erased from the build. */
  z.strictObject({
    kind: z.literal('erase_item'),
    handle: Handle,
  }),
  /**
   * A copy of an insert, text or curve, moved by (dx, dy) (ADR-050); the copy gets the handle
   * `FIX-<correction id>` and keeps the layer, block and attributes of the original.
   */
  z.strictObject({
    kind: z.literal('copy_item'),
    handle: Handle,
    dx: Coord,
    dy: Coord,
  }),
  /** Mirrored across the line through (x1, y1) and (x2, y2) (ADR-050); the two points differ. */
  z
    .strictObject({
      kind: z.literal('mirror_item'),
      handle: Handle,
      x1: Coord,
      y1: Coord,
      x2: Coord,
      y2: Coord,
    })
    .refine((m) => m.x1 !== m.x2 || m.y1 !== m.y2, 'The mirror line needs two different points'),
  /** Scaled by `factor` about (x, y) (ADR-050); a text's height scales too. */
  z.strictObject({
    kind: z.literal('scale_item'),
    handle: Handle,
    x: Coord,
    y: Coord,
    factor: z.number().refine(Number.isFinite).min(MIN_SCALE_FACTOR).max(MAX_SCALE_FACTOR),
  }),
  /**
   * A new line (2 points) or polyline drawn on `layer` (ADR-050), handle `FIX-<correction id>`;
   * the layer's rule decides what it is (e.g. a route).
   */
  z.strictObject({
    kind: z.literal('add_curve'),
    layer: LayerName,
    points: z
      .array(z.tuple([Coord, Coord]))
      .min(2)
      .max(MAX_CURVE_POINTS),
    closed: z.boolean().default(false),
  }),
  /**
   * A layer that means what `like` means in the mapping (ADR-050): items moved or drawn on it are
   * read with the rule of `like`. A new name starts empty; a layer of the drawing that has no rule
   * takes `like`'s meaning for everything on it (owner 2026-11-19: «the program understands what
   * was drawn»). `like: null` is a new layer for drawing only: the build ignores what is on it.
   */
  z
    .strictObject({
      kind: z.literal('add_layer'),
      layer: LayerName,
      like: LayerName.nullable(),
    })
    .refine((a) => a.layer !== a.like, 'The new layer needs its own name'),
  /** Every item on `from` moves to `to`, which keeps the rule of `from` (ADR-050). */
  z
    .strictObject({
      kind: z.literal('rename_layer'),
      from: LayerName,
      to: LayerName,
    })
    .refine((r) => r.from !== r.to, 'The new name must differ'),
  /** Every item on the layer is erased from the build (ADR-050). */
  z.strictObject({
    kind: z.literal('delete_layer'),
    layer: LayerName,
  }),
  /**
   * A curve's points are replaced (ADR-051): the result of Trim, Fillet, Stretch or Extend on the
   * drawing screen. The curve keeps its handle and layer.
   */
  z.strictObject({
    kind: z.literal('set_curve'),
    handle: Handle,
    points: z.array(Point).min(2).max(MAX_CURVE_POINTS),
    closed: z.boolean().default(false),
  }),
  /**
   * A dimension (2 points measured + 1 for the dimension line) or a leader (arrow tip first) drawn
   * on the screen (ADR-051). Saved and drawn; the build ignores it (no quantity, item or error).
   */
  z.strictObject({
    kind: z.literal('add_note'),
    note: DrawingNoteKindSchema,
    layer: LayerName,
    points: z.array(Point).min(1).max(MAX_NOTE_POINTS),
    text: Text.max(MAX_TEXT_LENGTH).nullable().default(null),
  }),
  /**
   * How an item is drawn on the screen (ADR-051): colour `#rrggbb`, line type, line weight in mm;
   * null = by layer (all null: back to the layer's look). The latest style of an item wins.
   * Saved and drawn; the build ignores it.
   */
  z.strictObject({
    kind: z.literal('set_style'),
    handle: Handle,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #rrggbb')
      .nullable()
      .default(null),
    linetype: DrawingLinetypeSchema.nullable().default(null),
    lineweight: z
      .number()
      .refine(Number.isFinite)
      .min(0)
      .max(MAX_LINEWEIGHT_MM)
      .nullable()
      .default(null),
  }),
  /**
   * A shape drawn on the screen (owner 2026-11-24): `points` is the closed boundary of a hatch,
   * gradient or wipeout (3 or more), the centre of a donut (`inner` / `outer` diameters), or the
   * point and the direction point of an XLINE / RAY. Saved and drawn; the build ignores it.
   */
  z
    .strictObject({
      kind: z.literal('add_shape'),
      shape: DrawingShapeKindSchema,
      layer: LayerName,
      points: z.array(Point).min(1).max(MAX_CURVE_POINTS),
      pattern: HatchPatternSchema.nullable().default(null),
      /** Pattern spacing factor of a hatch. */
      scale: z
        .number()
        .refine(Number.isFinite)
        .min(MIN_SCALE_FACTOR)
        .max(MAX_SCALE_FACTOR)
        .default(1),
      /** Pattern or gradient angle, degrees. */
      angle: z
        .number()
        .refine(Number.isFinite)
        .min(-MAX_ROTATION_DEG)
        .max(MAX_ROTATION_DEG)
        .default(0),
      /** null = the layer's colour. */
      color: Colour.nullable().default(null),
      /** The second colour of a gradient. */
      color2: Colour.nullable().default(null),
      inner: Size.nullable().default(null),
      outer: Size.nullable().default(null),
    })
    .superRefine((shape, ctx) => {
      const n = shape.points.length;
      const need =
        shape.shape === 'donut'
          ? n === 1
          : shape.shape === 'xline' || shape.shape === 'ray'
            ? n === 2
            : n >= 3;
      if (!need)
        ctx.addIssue({
          code: 'custom',
          path: ['points'],
          message: 'Wrong number of points for the shape',
        });
      if (
        shape.shape === 'donut' &&
        !(shape.outer !== null && shape.outer > 0 && (shape.inner ?? 0) < shape.outer)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['outer'],
          message: 'A donut needs an outer diameter above the inner one',
        });
      }
      const [a, b] = shape.points;
      if (
        (shape.shape === 'xline' || shape.shape === 'ray') &&
        a &&
        b &&
        a[0] === b[0] &&
        a[1] === b[1]
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['points'],
          message: 'The direction needs two different points',
        });
      }
    }),
  /**
   * The draw order of an item on the screen (AutoCAD's DRAWORDER, owner 2026-11-24): items are
   * drawn by `order`, lowest first; items without one keep the file's order at 0. Saved and drawn;
   * the build ignores it. The latest order of an item wins.
   */
  z.strictObject({
    kind: z.literal('set_order'),
    handle: Handle,
    order: z.number().refine(Number.isFinite).min(-MAX_DRAW_ORDER).max(MAX_DRAW_ORDER),
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

/** Corrections saved at once from the drawing's edit mode (ADR-047). */
export const MAX_CORRECTIONS_PER_SAVE = 200;

/**
 * POST /projects/:p/cad-files/:f/corrections/batch — the edits of one «حفظ»: all are kept, in this
 * order, or none (the first refusal is the answer).
 */
export const CreateDrawingCorrectionsRequestSchema = z.strictObject({
  items: z.array(CreateDrawingCorrectionRequestSchema).min(1).max(MAX_CORRECTIONS_PER_SAVE),
});
export type CreateDrawingCorrectionsRequest = z.infer<typeof CreateDrawingCorrectionsRequestSchema>;

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

/** Answer of POST …/corrections/batch: the saved corrections, in the order sent. */
export const DrawingCorrectionsSavedSchema = z.object({ items: z.array(DrawingCorrectionSchema) });
export type DrawingCorrectionsSaved = z.infer<typeof DrawingCorrectionsSavedSchema>;

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

export function moveLayerTargets(
  rules: readonly MappingRule[],
  corrections: readonly DrawingCorrectionInput[] = [],
): Set<string> {
  const out = new Set<string>();
  const ruled = new Set<string>();
  for (const rule of rules) {
    if (rule.source !== 'layer') continue;
    ruled.add(rule.layer);
    if (MOVE_LAYER_TARGETS.includes(rule.target)) out.add(rule.layer);
  }
  // A layer added or renamed by a correction means what its source layer means (ADR-050), unless
  // it has a rule of its own (the worker keeps that rule, ADR-051).
  for (const [layer, like] of layerAliases(corrections)) {
    if (out.has(like) && !ruled.has(layer)) out.add(layer);
  }
  return out;
}

/**
 * Layer → the mapped layer whose rule it takes, from `add_layer` and `rename_layer` corrections in
 * order (ADR-050). A chain (A renamed to B, B renamed to C) resolves to the first layer.
 */
export function layerAliases(corrections: readonly DrawingCorrectionInput[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of corrections) {
    if (c.kind === 'add_layer') {
      if (c.like !== null) out.set(c.layer, out.get(c.like) ?? c.like);
    } else if (c.kind === 'rename_layer') out.set(c.to, out.get(c.from) ?? c.from);
  }
  return out;
}
