import { z } from 'zod';
import { DrawingKindSchema, type DrawingKind } from './drawing-kind.schemas.js';
import { writtenMetres3 } from './text-roles.js';
import { DecimalStringSchema } from '../common/decimal.js';
import { readingOf } from '../design/feature-reading.schemas.js';

/**
 * How the bundles of a drawing are installed (ADR-040 G14–G17, ADR-042 part D):
 * - `trench`: dig, lay the bundle, backfill, blow the cable;
 * - `pull`: pull through existing pipes, then blow the cable.
 * A Secondary is all trench (no question; exceptions come later from the supervisor's records).
 * A General is pull, except the parts the PM marks as trench. After uploading a General the system
 * asks «المسار كله سحب في مواسير قديمة، ولا فيه جزء محتاج حفر وتركيب مواسير؟»:
 * - `pull_only` → the whole route is pull;
 * - `has_trench` → the trench parts are marked on «عارض الرسومات» (route + written length); the
 *   rest stays pull; one route can mix both (per route segment, not per drawing).
 *
 * The answer and the marks belong to the GENERAL CAD FILE (marks reference its drawing handles),
 * are append-only with who / when (as ADR-038 corrections), and are frozen on the design revision
 * at creation (`design_revisions.installation`). Owner principle: anything unclear is an error —
 * an unanswered question, `has_trench` with no mark, or a mark that does not fit its route blocks
 * publishing (`installation` check, `INSTALLATION_UNCLEAR`).
 */

export const INSTALLATION_METHODS = ['trench', 'pull'] as const;
export const InstallationMethodSchema = z.enum(INSTALLATION_METHODS);
export type InstallationMethod = z.infer<typeof InstallationMethodSchema>;

/** The installation method of every bundle of a drawing kind when nothing is marked. */
export const DEFAULT_INSTALLATION_METHOD: Readonly<Record<DrawingKind, InstallationMethod>> = {
  general: 'pull',
  secondary: 'trench',
};

/** Only the General is asked (ADR-040). */
export function installationQuestionApplies(kind: DrawingKind): boolean {
  return kind === 'general';
}

/** `pull_only`: no new pipes anywhere; `has_trench`: some parts need trenching and new pipes. */
export const INSTALLATION_ANSWERS = ['pull_only', 'has_trench'] as const;
export const InstallationAnswerSchema = z.enum(INSTALLATION_ANSWERS);
export type InstallationAnswer = z.infer<typeof InstallationAnswerSchema>;

// ---------- bounds (technical, not business rules) ----------

/** One mark is at most this many metres (a route segment between two points is far shorter). */
export const MAX_TRENCH_MARK_M = '100000';
/** Marks in force per file; rows including withdrawn ones are capped at 4× (as corrections). */
export const MAX_TRENCH_MARKS_PER_FILE = 2000;
export const MAX_TRENCH_MARK_ROWS_PER_FILE = 4 * MAX_TRENCH_MARKS_PER_FILE;
/** Answers kept per file (each change of answer is a row). */
export const MAX_INSTALLATION_ANSWERS_PER_FILE = 100;
/** Issues listed in a report; `issueCount` stays exact. */
export const MAX_INSTALLATION_ISSUES_LISTED = 200;

/** No control characters (as drawing corrections). */
const noControl = (value: string) => ![...value].some((char) => char.charCodeAt(0) < 0x20);
const Handle = z.string().min(1).max(64).refine(noControl, 'Control characters are not allowed');
const Actor = z.object({ id: z.uuid(), name: z.string() });

// ---------- metres as exact decimals (millimetres in bigint; never floats) ----------

const METRES_INPUT = /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/;

/** Decimal metres → millimetres. `writtenMetres3` rounding (half up) beyond 3 decimals. */
export function metresToMm(metres: string): bigint {
  return BigInt(writtenMetres3(metres).replace('.', ''));
}

/** Millimetres → metres with 3 decimals ("12.500"), as written lengths are stored. */
export function mmToMetres(mm: bigint): string {
  const negative = mm < 0n;
  const digits = (negative ? -mm : mm).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

/** A trench length typed by the PM: metres, > 0, ≤ MAX_TRENCH_MARK_M, at most 3 decimals. */
export const TrenchLengthSchema = z
  .string()
  .trim()
  .regex(METRES_INPUT, 'Expected metres with at most 3 decimals')
  // Checks keep running after a failed regex: only parse what matched.
  .refine((m) => !METRES_INPUT.test(m) || metresToMm(m) > 0n, 'The length must be above 0')
  .refine(
    (m) => !METRES_INPUT.test(m) || metresToMm(m) <= metresToMm(MAX_TRENCH_MARK_M),
    'The length is too large',
  )
  .transform((m) => writtenMetres3(m));

// ---------- the answer ----------

/** PUT /projects/:p/cad-files/:f/installation/answer (General files only). */
export const SetInstallationAnswerRequestSchema = z.strictObject({
  answer: InstallationAnswerSchema,
});
export type SetInstallationAnswerRequest = z.infer<typeof SetInstallationAnswerRequestSchema>;

export const InstallationAnswerRecordSchema = z.object({
  id: z.uuid(),
  cadFileId: z.uuid(),
  answer: InstallationAnswerSchema,
  answeredBy: Actor.nullable(),
  answeredAt: z.iso.datetime({ offset: true }),
});
export type InstallationAnswerRecord = z.infer<typeof InstallationAnswerRecordSchema>;

// ---------- trench marks ----------

/**
 * POST /projects/:p/cad-files/:f/installation/trench-marks — «حفر جديد» on a route piece picked on
 * the canvas: the route's drawing handle (the top-level handle of the curve, as the viewer picks)
 * and the trench length WRITTEN by the PM. Several marks may sit on one route (several parts); their
 * sum must not exceed the route's written length (checked on the built revision).
 */
export const CreateTrenchMarkRequestSchema = z.strictObject({
  routeHandle: Handle,
  lengthM: TrenchLengthSchema,
});
export type CreateTrenchMarkRequest = z.infer<typeof CreateTrenchMarkRequestSchema>;

export const TrenchMarkSchema = z.object({
  id: z.uuid(),
  cadFileId: z.uuid(),
  routeHandle: Handle,
  /** Metres, 3 decimals. */
  lengthM: DecimalStringSchema,
  createdBy: Actor.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Withdrawn marks stay in history and no longer count (withdrawn once, never deleted). */
  withdrawnBy: Actor.nullable(),
  withdrawnAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TrenchMark = z.infer<typeof TrenchMarkSchema>;

/**
 * GET /projects/:p/cad-files/:f/installation — the live state of the file (what the next build
 * freezes). For a Secondary `asked` is false and everything is empty.
 */
export const InstallationStateSchema = z.object({
  cadFileId: z.uuid(),
  drawingKind: DrawingKindSchema,
  /** The question applies to this file (General). */
  asked: z.boolean(),
  /** Current answer (latest row); null = not answered yet. */
  answer: InstallationAnswerRecordSchema.nullable(),
  /** Every answer given, newest first. */
  answerHistory: z.array(InstallationAnswerRecordSchema).max(MAX_INSTALLATION_ANSWERS_PER_FILE),
  /** Newest first, withdrawn ones included. */
  marks: z.array(TrenchMarkSchema).max(MAX_TRENCH_MARK_ROWS_PER_FILE),
  activeMarkCount: z.number().int().min(0),
  /** Σ lengths of the marks in force, metres 3 decimals. */
  activeTrenchM: DecimalStringSchema,
});
export type InstallationState = z.infer<typeof InstallationStateSchema>;

/**
 * `details.reason` of refused installation writes:
 * - NOT_GENERAL_DRAWING (409): the file is a Secondary (no question, all trench);
 * - FILE_SUPERSEDED (409): a newer version of the General exists; answer on that one;
 * - NOT_PROCESSED (409): marks need the processed file (its curves);
 * - ANSWER_NOT_TRENCH (409): a mark is added while the answer is not `has_trench`;
 * - TRENCH_MARKS_ACTIVE (409): `pull_only` while marks are in force (withdraw them first);
 * - ROUTE_NOT_FOUND (422): the handle is not a curve of the file's extraction;
 * - TOO_MANY_MARKS / TOO_MANY_ANSWERS (409): technical caps reached;
 * - ALREADY_WITHDRAWN (409): the mark was withdrawn before.
 */
export const INSTALLATION_WRITE_REFUSALS = [
  'NOT_GENERAL_DRAWING',
  'FILE_SUPERSEDED',
  'NOT_PROCESSED',
  'ANSWER_NOT_TRENCH',
  'TRENCH_MARKS_ACTIVE',
  'ROUTE_NOT_FOUND',
  'TOO_MANY_MARKS',
  'TOO_MANY_ANSWERS',
  'ALREADY_WITHDRAWN',
] as const;
export type InstallationWriteRefusal = (typeof INSTALLATION_WRITE_REFUSALS)[number];

// ---------- frozen on the revision ----------

export const FrozenTrenchMarkSchema = z.object({
  id: z.uuid(),
  routeHandle: Handle,
  lengthM: DecimalStringSchema,
});
export type FrozenTrenchMark = z.infer<typeof FrozenTrenchMarkSchema>;

/**
 * `design_revisions.installation`, frozen at creation for a General (null for a Secondary and for
 * revisions built before migration 0022): the answer in force and the marks in force, in creation
 * order. A later answer or mark needs a new build («طبّق وابنِ من جديد»), like corrections.
 */
export const FrozenInstallationSchema = z.object({
  answer: InstallationAnswerSchema.nullable(),
  /** The answer row frozen; null when unanswered. */
  answerId: z.uuid().nullable(),
  marks: z.array(FrozenTrenchMarkSchema).max(MAX_TRENCH_MARKS_PER_FILE),
});
export type FrozenInstallation = z.infer<typeof FrozenInstallationSchema>;

/** The live answer and marks differ from what a revision froze: the PM must rebuild. */
export function installationChangedSince(
  frozen: FrozenInstallation | null,
  live: { answerId: string | null; activeMarkIds: readonly string[] },
): boolean {
  const frozenAnswerId = frozen?.answerId ?? null;
  if (frozenAnswerId !== live.answerId) return true;
  const frozenIds = new Set((frozen?.marks ?? []).map((m) => m.id));
  if (frozenIds.size !== live.activeMarkIds.length) return true;
  return live.activeMarkIds.some((id) => !frozenIds.has(id));
}

// ---------- evaluation (readiness, publish, part H) ----------

/**
 * Why a General's installation is unclear (each blocks publishing):
 * - QUESTION_UNANSWERED: no answer frozen on the revision (answer, then rebuild);
 * - TRENCH_NOT_MARKED: `has_trench` with zero marks;
 * - MARKS_WITH_PULL_ONLY: `pull_only` with marks (the API prevents it; checked again);
 * - MARK_ROUTE_MISSING: a mark's handle is no route of the revision (deleted, re-layered, …);
 * - ROUTE_LENGTH_UNKNOWN: a marked route has no written bundle length to compare with;
 * - TRENCH_LONGER_THAN_ROUTE: Σ marks on a route > its written length (equal is allowed).
 */
export const INSTALLATION_ISSUE_CODES = [
  'QUESTION_UNANSWERED',
  'TRENCH_NOT_MARKED',
  'MARKS_WITH_PULL_ONLY',
  'MARK_ROUTE_MISSING',
  'ROUTE_LENGTH_UNKNOWN',
  'TRENCH_LONGER_THAN_ROUTE',
] as const;
export const InstallationIssueCodeSchema = z.enum(INSTALLATION_ISSUE_CODES);
export type InstallationIssueCode = z.infer<typeof InstallationIssueCodeSchema>;

export const InstallationIssueSchema = z.object({
  code: InstallationIssueCodeSchema,
  /** The marks concerned (empty for QUESTION_UNANSWERED / TRENCH_NOT_MARKED). */
  markIds: z.array(z.uuid()),
  /** The route as marked (drawing handle) and the route feature it resolved to. */
  routeHandle: Handle.nullable(),
  featureId: z.uuid().nullable(),
  /** Σ marked metres on the route and its written length (TRENCH_LONGER_THAN_ROUTE). */
  markedM: DecimalStringSchema.nullable(),
  routeLengthM: DecimalStringSchema.nullable(),
});
export type InstallationIssue = z.infer<typeof InstallationIssueSchema>;

export const InstallationRouteTotalSchema = z.object({
  featureId: z.uuid(),
  routeHandle: Handle,
  routeLengthM: DecimalStringSchema,
  trenchM: DecimalStringSchema,
  pullM: DecimalStringSchema,
});
export type InstallationRouteTotal = z.infer<typeof InstallationRouteTotalSchema>;

/**
 * Lengths for the quantities (ADR-040 part H), derived — never stored — from the revision's frozen
 * installation and its route features (both immutable once published). Lengths are the WRITTEN
 * bundle lengths (ADR-040). null whenever the installation is unclear.
 */
export const InstallationTotalsSchema = z.object({
  /** Σ marked trench metres. */
  trenchM: DecimalStringSchema,
  /** Σ written lengths of every route − trenchM. */
  pullM: DecimalStringSchema,
  /** Routes with no written length: their pull length is unknown (also LABEL_MISSING). */
  routesWithoutLength: z.number().int().min(0),
  /** Marked routes only, by route handle. */
  marked: z.array(InstallationRouteTotalSchema),
});
export type InstallationTotals = z.infer<typeof InstallationTotalsSchema>;

/** GET …/design-revisions/:r/installation and `PublishReadiness.installation`. */
export const InstallationReportSchema = z.object({
  /** The question applies (General). A Secondary is all trench: ok, no totals here. */
  applies: z.boolean(),
  frozen: FrozenInstallationSchema.nullable(),
  ok: z.boolean(),
  issueCount: z.number().int().min(0),
  issues: z.array(InstallationIssueSchema).max(MAX_INSTALLATION_ISSUES_LISTED),
  totals: InstallationTotalsSchema.nullable(),
});
export type InstallationReport = z.infer<typeof InstallationReportSchema>;

/** A route feature of the revision as the evaluation needs it. */
export interface InstallationRoute {
  featureId: string;
  /** `design_features.source_handle` (a merged route keeps its smallest piece handle). */
  sourceHandle: string;
  /** Written bundle length (`attrs.reading.writtenLengthM`); null when not written / legacy. */
  writtenLengthM: string | null;
}

/** A route design feature → InstallationRoute; null for other feature types. */
export function installationRouteOf(feature: {
  id: string;
  featureType: string;
  sourceHandle: string;
  attrs: Readonly<Record<string, unknown>>;
}): InstallationRoute | null {
  if (feature.featureType !== 'route') return null;
  const reading = readingOf(feature.attrs);
  return {
    featureId: feature.id,
    sourceHandle: feature.sourceHandle,
    writtenLengthM: reading?.of === 'route' ? reading.writtenLengthM : null,
  };
}

/**
 * Handle → the handle the build keys its route by, through the frozen `merge_routes` corrections
 * (pieces become one route keyed by the smallest handle, as the worker's `merge_curves`; chained
 * merges join). A handle in no merge keys itself.
 */
export function routeKeyResolver(
  merges: readonly (readonly string[])[],
): (handle: string) => string {
  const parent = new Map<string, string>();
  const find = (h: string): string => {
    let root = h;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const handles of merges) {
    const roots = [...new Set(handles.map(find))];
    if (roots.length === 0) continue;
    const key = roots.reduce((a, b) => (b < a ? b : a));
    for (const root of roots) parent.set(root, key);
    parent.set(key, key);
  }
  return find;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The installation check of one revision (pure; API readiness, publish and part H use it).
 * Secondary → applies false, ok. General → the issues above, in INSTALLATION_ISSUE_CODES order then
 * route handle; totals only when ok.
 */
export function evaluateInstallation(input: {
  drawingKind: DrawingKind;
  frozen: FrozenInstallation | null;
  routes: readonly InstallationRoute[];
  /** `handles` of the revision's frozen `merge_routes` corrections. */
  merges: readonly (readonly string[])[];
}): InstallationReport {
  const { drawingKind, frozen, routes, merges } = input;
  if (!installationQuestionApplies(drawingKind)) {
    return { applies: false, frozen: null, ok: true, issueCount: 0, issues: [], totals: null };
  }
  const issues: InstallationIssue[] = [];
  const issue = (
    code: InstallationIssueCode,
    more: Partial<Omit<InstallationIssue, 'code'>> = {},
  ): void => {
    issues.push({
      code,
      markIds: [],
      routeHandle: null,
      featureId: null,
      markedM: null,
      routeLengthM: null,
      ...more,
    });
  };
  const marks = frozen?.marks ?? [];
  const answer = frozen?.answer ?? null;
  if (answer === null) issue('QUESTION_UNANSWERED');
  if (answer === 'has_trench' && marks.length === 0) issue('TRENCH_NOT_MARKED');
  if (answer === 'pull_only' && marks.length > 0) {
    issue('MARKS_WITH_PULL_ONLY', { markIds: marks.map((m) => m.id) });
  }

  const keyOf = routeKeyResolver(merges);
  const routeByHandle = new Map(routes.map((r) => [r.sourceHandle, r]));
  const marksByRoute = new Map<string, FrozenTrenchMark[]>();
  for (const mark of marks) {
    const route = routeByHandle.get(keyOf(mark.routeHandle));
    if (!route) {
      issue('MARK_ROUTE_MISSING', { markIds: [mark.id], routeHandle: mark.routeHandle });
      continue;
    }
    const list = marksByRoute.get(route.sourceHandle) ?? [];
    list.push(mark);
    marksByRoute.set(route.sourceHandle, list);
  }
  const marked: InstallationRouteTotal[] = [];
  for (const handle of [...marksByRoute.keys()].sort(byString)) {
    const route = routeByHandle.get(handle) as InstallationRoute; // keyed from routeByHandle above
    const onRoute = marksByRoute.get(handle) ?? [];
    const markedMm = onRoute.reduce((sum, m) => sum + metresToMm(m.lengthM), 0n);
    const where = {
      markIds: onRoute.map((m) => m.id),
      routeHandle: handle,
      featureId: route.featureId,
      markedM: mmToMetres(markedMm),
    };
    if (route.writtenLengthM === null) {
      issue('ROUTE_LENGTH_UNKNOWN', where);
      continue;
    }
    const routeMm = metresToMm(route.writtenLengthM);
    if (markedMm > routeMm) {
      issue('TRENCH_LONGER_THAN_ROUTE', { ...where, routeLengthM: mmToMetres(routeMm) });
      continue;
    }
    marked.push({
      featureId: route.featureId,
      routeHandle: handle,
      routeLengthM: mmToMetres(routeMm),
      trenchM: mmToMetres(markedMm),
      pullM: mmToMetres(routeMm - markedMm),
    });
  }

  const order = (code: InstallationIssueCode) => INSTALLATION_ISSUE_CODES.indexOf(code);
  issues.sort(
    (a, b) => order(a.code) - order(b.code) || byString(a.routeHandle ?? '', b.routeHandle ?? ''),
  );
  const ok = issues.length === 0;
  let totals: InstallationTotals | null = null;
  if (ok) {
    const trenchMm = marked.reduce((sum, r) => sum + metresToMm(r.trenchM), 0n);
    const writtenMm = routes.reduce(
      (sum, r) => (r.writtenLengthM === null ? sum : sum + metresToMm(r.writtenLengthM)),
      0n,
    );
    totals = {
      trenchM: mmToMetres(trenchMm),
      pullM: mmToMetres(writtenMm - trenchMm),
      routesWithoutLength: routes.filter((r) => r.writtenLengthM === null).length,
      marked,
    };
  }
  return {
    applies: true,
    frozen,
    ok,
    issueCount: issues.length,
    issues: issues.slice(0, MAX_INSTALLATION_ISSUES_LISTED),
    totals,
  };
}
