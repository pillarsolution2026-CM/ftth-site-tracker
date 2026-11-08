import { z } from 'zod';
import { FeatureTypeSchema } from './feature-types.js';

/**
 * Drawing problems found while a design revision is built (ADR-033, ADR-034). The build never
 * stops for them: each one says where it is so the user can fix the drawing and upload it again,
 * or ignore it on their own responsibility (recorded; screen and API in a later change).
 * Mirrored by `workers/cad/cad_worker/domain/drawing_checks.py`. Stored in
 * `design_revisions.warnings` next to the older count-only warnings.
 */
export const DRAWING_PROBLEM_CODES = [
  /** A route drawn as separate pieces meeting end to end away from any item. */
  'ROUTE_SPLIT',
  /** A ring with no ring label, or ring labels that match no ring. */
  'RING_LABEL_MISMATCH',
  /** An item or its label on the layer of another rule (suggestion: move it / unify layers). */
  'WRONG_LAYER',
  /** A symbol with no label, on a type whose other symbols have labels. */
  'LABEL_MISSING',
  /** The rule says one kind (e.g. joint 36), the label another (e.g. "Joint 144"). */
  'LABEL_TYPE_MISMATCH',
  /** A cable / duct label with its type but no length (information only). */
  'LABEL_LENGTH_MISSING',
] as const;
export const DrawingProblemCodeSchema = z.enum(DRAWING_PROBLEM_CODES);
export type DrawingProblemCode = z.infer<typeof DrawingProblemCodeSchema>;

export const PROBLEM_SEVERITIES = ['error', 'warning', 'info'] as const;
export const ProblemSeveritySchema = z.enum(PROBLEM_SEVERITIES);
export type ProblemSeverity = z.infer<typeof ProblemSeveritySchema>;

export const DRAWING_PROBLEM_SEVERITY: Readonly<Record<DrawingProblemCode, ProblemSeverity>> = {
  ROUTE_SPLIT: 'warning',
  RING_LABEL_MISMATCH: 'warning',
  WRONG_LAYER: 'warning',
  LABEL_MISSING: 'warning',
  LABEL_TYPE_MISMATCH: 'error',
  LABEL_LENGTH_MISSING: 'info',
};

/** The nearest named item, to tell the user where to look ("near cabinet 1-6"). */
export const ProblemNearSchema = z.object({
  type: FeatureTypeSchema,
  /** Its code or label; null when it has none. */
  name: z.string().nullable(),
  layer: z.string(),
  distanceM: z.number().min(0),
});

export const DrawingProblemItemSchema = z.object({
  /** Revision CRS (metres). */
  x: z.number(),
  y: z.number(),
  /** Drawing coordinates, to find the spot in AutoCAD (ZOOM C x,y). */
  drawingX: z.number(),
  drawingY: z.number(),
  layer: z.string(),
  handle: z.string(),
  /** WRONG_LAYER: the layer it belongs on. */
  suggestedLayer: z.string().nullable(),
  /** The label text involved, when there is one. */
  text: z.string().nullable(),
  near: ProblemNearSchema.nullable(),
});
export type DrawingProblemItem = z.infer<typeof DrawingProblemItemSchema>;

export const MAX_PROBLEM_ITEMS = 500;

export const DrawingProblemSchema = z.object({
  code: DrawingProblemCodeSchema,
  severity: ProblemSeveritySchema,
  count: z.number().int().min(1),
  /** The first MAX_PROBLEM_ITEMS places; `count` is the full number. */
  items: z.array(DrawingProblemItemSchema).max(MAX_PROBLEM_ITEMS),
});
export type DrawingProblem = z.infer<typeof DrawingProblemSchema>;

// ---------- API: list (ADR-034, ADR-038) ----------

/**
 * ADR-038: every problem is an error that blocks publishing; Ignore (ADR-034) is withdrawn and
 * ignores recorded earlier no longer count. The severity stays only as a display hint. The web shows
 * per code a description and what is required to fix it (i18n `designRevisions.problems.<code>`).
 */
export const DrawingProblemViewSchema = DrawingProblemSchema;
export type DrawingProblemView = z.infer<typeof DrawingProblemViewSchema>;

/** GET …/design-revisions/:revisionId/problems — empty for revisions built before ADR-033. */
export const DrawingProblemListSchema = z.object({
  items: z.array(DrawingProblemViewSchema),
  /** Every place of every problem; publishing needs 0 (ADR-038). */
  total: z.number().int().min(0),
});
export type DrawingProblemList = z.infer<typeof DrawingProblemListSchema>;

/** Reads the problems out of `design_revisions.warnings` (older count-only warnings are skipped). */
export function drawingProblemsOf(warnings: unknown): DrawingProblem[] {
  if (!Array.isArray(warnings)) return [];
  const out: DrawingProblem[] = [];
  for (const entry of warnings) {
    const parsed = DrawingProblemSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
