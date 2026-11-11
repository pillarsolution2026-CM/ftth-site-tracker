import { z } from 'zod';
import { CABINET_INFO_FIELDS, TextRoleSchema } from '../cad/text-roles.js';
import { DecimalStringSchema } from '../common/decimal.js';
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
  // ---- ADR-041 (reading by meaning, ADR-040 F); only in `roles` reading mode ----
  /** General: a handhole symbol with no type text (handhole_type) next to it. */
  'HANDHOLE_TYPE_MISSING',
  /** General: a handhole type text outside the list DH, HH-I (HH1), HH-II (CH), MH-I…MH-IV. */
  'HANDHOLE_TYPE_UNKNOWN',
  /** General: a handhole name written (handhole_number, e.g. «CH01») with no symbol drawn. */
  'HANDHOLE_NOT_DRAWN',
  /** Secondary: two boxes with the same number under one cabinet (one place per box). */
  'BOX_NUMBER_DUPLICATE',
  /** Secondary: a box no 1way bundle reaches. */
  'BOX_NOT_REACHED',
  /** Secondary: the cabinet's written box count («22B») ≠ boxes drawn under its name. */
  'CABINET_BOX_COUNT_MISMATCH',
  /** Secondary: a cabinet with no zone line around it. */
  'CABINET_ZONE_MISSING',
  /** General: «SP n» ≠ main cable cores − Σ branch cable cores. */
  'SPARE_CORES_MISMATCH',
  /** General: cable shorter than its bundle, or spare (cable − bundle) under 15 m. */
  'CABLE_SLACK_TOO_SHORT',
  /** General: spare (cable − bundle) above 30 m. WARNING: does not block publishing. */
  'CABLE_SLACK_TOO_LONG',
] as const;
export const DrawingProblemCodeSchema = z.enum(DRAWING_PROBLEM_CODES);
export type DrawingProblemCode = z.infer<typeof DrawingProblemCodeSchema>;

export const PROBLEM_SEVERITIES = ['error', 'warning', 'info'] as const;
export const ProblemSeveritySchema = z.enum(PROBLEM_SEVERITIES);
export type ProblemSeverity = z.infer<typeof ProblemSeveritySchema>;

/** Display hint only (ADR-038); what blocks publishing is DRAWING_PROBLEM_BLOCKS. */
export const DRAWING_PROBLEM_SEVERITY: Readonly<Record<DrawingProblemCode, ProblemSeverity>> = {
  ROUTE_SPLIT: 'warning',
  RING_LABEL_MISMATCH: 'warning',
  WRONG_LAYER: 'warning',
  LABEL_MISSING: 'warning',
  LABEL_TYPE_MISMATCH: 'error',
  LABEL_LENGTH_MISSING: 'info',
  HANDHOLE_TYPE_MISSING: 'error',
  HANDHOLE_TYPE_UNKNOWN: 'error',
  HANDHOLE_NOT_DRAWN: 'error',
  BOX_NUMBER_DUPLICATE: 'error',
  BOX_NOT_REACHED: 'error',
  CABINET_BOX_COUNT_MISMATCH: 'error',
  CABINET_ZONE_MISSING: 'error',
  SPARE_CORES_MISMATCH: 'error',
  CABLE_SLACK_TOO_SHORT: 'error',
  CABLE_SLACK_TOO_LONG: 'warning',
};

/**
 * Whether a code blocks publishing. ADR-038: every problem blocks; ADR-040 adds the first
 * non-blocking one, «cable longer than its bundle by more than 30 m». Decided by the code, never by
 * the stored severity (Phase-1 codes are stored as `warning` and still block).
 */
export const DRAWING_PROBLEM_BLOCKS: Readonly<Record<DrawingProblemCode, boolean>> = {
  ROUTE_SPLIT: true,
  RING_LABEL_MISMATCH: true,
  WRONG_LAYER: true,
  LABEL_MISSING: true,
  LABEL_TYPE_MISMATCH: true,
  LABEL_LENGTH_MISSING: true,
  HANDHOLE_TYPE_MISSING: true,
  HANDHOLE_TYPE_UNKNOWN: true,
  HANDHOLE_NOT_DRAWN: true,
  BOX_NUMBER_DUPLICATE: true,
  BOX_NOT_REACHED: true,
  CABINET_BOX_COUNT_MISMATCH: true,
  CABINET_ZONE_MISSING: true,
  SPARE_CORES_MISMATCH: true,
  CABLE_SLACK_TOO_SHORT: true,
  CABLE_SLACK_TOO_LONG: false,
};

export const blocksPublishing = (code: DrawingProblemCode): boolean => DRAWING_PROBLEM_BLOCKS[code];

/**
 * Owner thresholds (ADR-040), metres, compared as decimals: spare = cable − bundle; spare < 15
 * (cable shorter included) → CABLE_SLACK_TOO_SHORT; spare > 30 → CABLE_SLACK_TOO_LONG; 15 and 30
 * themselves are fine.
 */
export const CABLE_SLACK_MIN_M = '15';
export const CABLE_SLACK_WARN_ABOVE_M = '30';

/** The nearest named item, to tell the user where to look ("near cabinet 1-6"). */
export const ProblemNearSchema = z.object({
  type: FeatureTypeSchema,
  /** Its code or label; null when it has none. */
  name: z.string().nullable(),
  layer: z.string(),
  distanceM: z.number().finite().min(0),
});

/**
 * Values a problem place names in its message (ADR-041); every key optional, set per code:
 * - LABEL_MISSING (roles mode): `role` missing (+ `field` for cabinet_info, e.g. `name`);
 * - LABEL_TYPE_MISMATCH on a route: `role` bundle_label, `expected` the layer's ways ("12"),
 *   `found` the label's ("7"), `featureHandle` the route; on a point: unchanged (no params);
 * - HANDHOLE_TYPE_UNKNOWN: `found` the written type;
 * - BOX_NUMBER_DUPLICATE: `cabinet`, `boxNumber`, `featureHandle` the box;
 * - CABINET_BOX_COUNT_MISMATCH: `cabinet`, `expected` written count, `found` boxes drawn;
 * - SPARE_CORES_MISMATCH: `expected` main − Σ branches, `found` written, `mainCores`;
 * - CABLE_SLACK_*: `cableLengthM`, `bundleLengthM`, `slackM` (decimal strings), `featureHandle`.
 * Absent on problems stored before ADR-041.
 */
/** Technical bound on a written core count (largest cables are a few thousand cores). */
export const MAX_PARAM_CORES = 100_000;

const DrawingProblemParamsFields = z
  .object({
    role: TextRoleSchema,
    field: z.enum(CABINET_INFO_FIELDS),
    cabinet: z.string(),
    boxNumber: z.string(),
    expected: z.string(),
    found: z.string(),
    mainCores: z.number().finite().int().min(1).max(MAX_PARAM_CORES),
    cableLengthM: DecimalStringSchema,
    bundleLengthM: DecimalStringSchema,
    slackM: DecimalStringSchema,
    /** The feature the place is about when `handle` is a text (so a fix can target either). */
    featureHandle: z.string(),
  })
  .partial();
export const DrawingProblemParamsSchema = DrawingProblemParamsFields;
export type DrawingProblemParams = z.infer<typeof DrawingProblemParamsSchema>;

export const DrawingProblemItemSchema = z.object({
  /** Revision CRS (metres). */
  x: z.number().finite(),
  y: z.number().finite(),
  /** Drawing coordinates, to find the spot in AutoCAD (ZOOM C x,y). */
  drawingX: z.number().finite(),
  drawingY: z.number().finite(),
  layer: z.string(),
  /**
   * The place key (correction `problem.handle`). For problems fixed by editing a text
   * (HANDHOLE_TYPE_UNKNOWN, HANDHOLE_NOT_DRAWN, BOX_NUMBER_DUPLICATE, CABINET_BOX_COUNT_MISMATCH,
   * SPARE_CORES_MISMATCH, CABLE_SLACK_*, route LABEL_TYPE_MISMATCH) it is the text's handle;
   * otherwise the symbol's (or "A/B" for ROUTE_SPLIT).
   */
  handle: z.string(),
  /** WRONG_LAYER: the layer it belongs on; LABEL_MISSING / HANDHOLE_TYPE_MISSING: where to type. */
  suggestedLayer: z.string().nullable(),
  /** The label text involved, when there is one. */
  text: z.string().nullable(),
  near: ProblemNearSchema.nullable(),
  params: DrawingProblemParamsSchema.optional(),
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
  /** Every place of every BLOCKING problem (DRAWING_PROBLEM_BLOCKS); publishing needs 0. */
  total: z.number().int().min(0),
  /** Places of non-blocking problems (warnings, ADR-041); shown, never block. */
  warningTotal: z.number().int().min(0).default(0),
  /** Stored entries that could not be read at all; each counts once in `total` (fail closed). */
  unreadable: z.number().int().min(0).optional(),
});
export type DrawingProblemList = z.infer<typeof DrawingProblemListSchema>;

const KNOWN_CODES: ReadonlySet<string> = new Set(DRAWING_PROBLEM_CODES);

type Salvaged = { problem: DrawingProblem } | { unreadable: true } | { legacy: true };

/**
 * Reads one stored entry. Strict parse first; a known code that fails it is salvaged leniently
 * (count kept, bad places dropped) so its count still reaches the publish gate. An unknown code is
 * an older count-only warning (skipped); anything that is not even an object with a code is
 * unreadable and still blocks.
 */
function readEntry(entry: unknown): Salvaged {
  const strict = DrawingProblemSchema.safeParse(entry);
  if (strict.success) return { problem: strict.data };
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    return { unreadable: true };
  const raw = entry as { code?: unknown; count?: unknown; items?: unknown; severity?: unknown };
  if (typeof raw.code !== 'string') return { unreadable: true };
  if (!KNOWN_CODES.has(raw.code)) return { legacy: true };
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item) => DrawingProblemItemSchema.safeParse(item))
    .flatMap((r) => (r.success ? [r.data] : []))
    .slice(0, MAX_PROBLEM_ITEMS);
  const count =
    typeof raw.count === 'number' && Number.isSafeInteger(raw.count) && raw.count >= 1
      ? raw.count
      : Math.max(1, Array.isArray(raw.items) ? raw.items.length : 0);
  const severity = ProblemSeveritySchema.safeParse(raw.severity);
  return {
    problem: {
      code: raw.code as DrawingProblemCode,
      severity: severity.success ? severity.data : 'error',
      count,
      items,
    },
  };
}

/**
 * Reads the problems out of `design_revisions.warnings` (older count-only warnings are skipped).
 * Fails closed: an entry of a known code that does not parse strictly is kept with its count.
 */
export function drawingProblemsOf(warnings: unknown): DrawingProblem[] {
  if (!Array.isArray(warnings)) return [];
  const out: DrawingProblem[] = [];
  for (const entry of warnings) {
    const read = readEntry(entry);
    if ('problem' in read) out.push(read.problem);
  }
  return out;
}

/** Entries of `warnings` that cannot be read at all (not an object with a code). */
export function unreadableProblemCount(warnings: unknown): number {
  if (!Array.isArray(warnings)) return 0;
  return warnings.filter((entry) => 'unreadable' in readEntry(entry)).length;
}

/** Places that block publishing and places that only warn (summed `count`s). */
export function problemTotals(problems: readonly DrawingProblem[]): {
  blocking: number;
  warnings: number;
} {
  let blocking = 0;
  let warnings = 0;
  for (const p of problems) {
    if (blocksPublishing(p.code)) blocking += p.count;
    else warnings += p.count;
  }
  return { blocking, warnings };
}

/** Fail-closed totals straight from the stored warnings: unreadable entries block (1 each). */
export function problemTotalsOf(warnings: unknown): {
  blocking: number;
  warnings: number;
  unreadable: number;
} {
  const unreadable = unreadableProblemCount(warnings);
  const totals = problemTotals(drawingProblemsOf(warnings));
  return { blocking: totals.blocking + unreadable, warnings: totals.warnings, unreadable };
}
