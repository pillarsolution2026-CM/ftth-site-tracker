import { z } from 'zod';
import { DrawingKindSchema, type DrawingKind } from './drawing-kind.schemas.js';
import type { ReadingMode } from './cad-mapping.schemas.js';

/**
 * Box type by the drawn shape (ADR-040 part E, ADR-043).
 *
 * Boxes carry no type text or attribute, and one symbol may mean «بوكس 8 فرعة بسبليتر 4» in one
 * drawing and «بوكس 4 فرعة بسبليتر 4» in another: the meaning is PER DRAWING. So:
 * - the worker gives every box a SHAPE SIGNATURE — a hash of what its symbol looks like (block
 *   geometry exploded, moved to its drawn centre, insert rotation and size removed, quantized),
 *   never its block name: two block names that look the same are one shape, one block drawn
 *   mirrored or stretched is another (when in doubt the worker splits; it never merges);
 * - the revision lists the shapes with a picture and the number of boxes of each (`BoxShapeGallery`,
 *   `design_revisions.box_shapes`);
 * - the PM picks, in front of each shape, a LINE OF THE PROJECT'S WORK ORDER (owner 2026-11-12,
 *   option أ: the type list is the work order's BOQ lines; no other list exists). Choices belong to
 *   the Secondary CAD FILE, are append-only with who / when, and are frozen on the design revision
 *   at creation (`design_revisions.box_types`), like corrections and the installation (ADR-042);
 * - the type shows as a text next to every box in «عارض الرسومات» and in the downloaded DXF.
 * Owner principle: anything unclear is an error — a shape with no line chosen, a chosen line that
 * no longer exists, a box whose shape could not be read: each blocks publishing (`box_types` check,
 * `BOX_TYPES_UNCLEAR`).
 */

/** Box types are chosen on the Secondary, read by roles (ADR-041); legacy mode has no reading. */
export function boxTypesApply(kind: DrawingKind, mode: ReadingMode): boolean {
  return kind === 'secondary' && mode === 'roles';
}

// ---------- shape signature ----------

/**
 * Version of the worker's normalization (workers/cad/cad_worker/domain/box_shapes.py). A new
 * version gives new signatures: earlier choices then match nothing and the shapes read as unset
 * (safe: nothing is guessed).
 */
export const BOX_SHAPE_ALGORITHM_VERSION = 1;

/** A box added on the program page (`add_item` correction): nothing is drawn, one shape of its own. */
export const BOX_SHAPE_NONE = 'none';

/** `v<version>-<sha256 hex>` or `none`. */
export const BoxShapeSignatureSchema = z
  .string()
  .regex(/^(v[1-9]\d{0,2}-[0-9a-f]{64}|none)$/, 'Expected a box shape signature');
export type BoxShapeSignature = z.infer<typeof BoxShapeSignatureSchema>;

/**
 * Where a box's shape comes from:
 * - `block`: an INSERT; its block geometry (nested blocks exploded, ATTRIBs left out);
 * - `shapes`: a group of closed shapes on a box layer (ADR-033);
 * - `text`: a `text` rule (the text itself is the symbol);
 * - `none`: added on the program page (`BOX_SHAPE_NONE`).
 */
export const BOX_SHAPE_SOURCES = ['block', 'shapes', 'text', 'none'] as const;
export const BoxShapeSourceSchema = z.enum(BOX_SHAPE_SOURCES);
export type BoxShapeSource = z.infer<typeof BoxShapeSourceSchema>;

// ---------- bounds (technical, not business rules; DoS limits) ----------

/** Shapes listed per revision; more distinct shapes than this is unclear (BOX_SHAPES_TOO_MANY). */
export const MAX_BOX_SHAPES = 200;
/** Vertices of one preview; the worker drops the shortest paths beyond it (`truncated`). */
export const MAX_BOX_SHAPE_PREVIEW_VERTICES = 256;
export const MAX_BOX_SHAPE_PREVIEW_PATHS = 128;
export const MAX_BOX_SHAPE_PREVIEW_TEXTS = 8;
export const MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH = 32;
/** Distinct insert signatures with a stored preview per CAD file (`cad_file_shapes`, import). */
export const MAX_FILE_SHAPES = 2000;
/** Block names / sample handles kept per shape (information, zoom on the viewer). */
export const MAX_BOX_SHAPE_BLOCK_NAMES = 20;
export const MAX_BOX_SHAPE_SAMPLES = 5;
/** Choices in force per file (distinct shapes); rows including history are capped at 4×. */
export const MAX_BOX_TYPE_CHOICES_PER_FILE = 1000;
export const MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE = 4 * MAX_BOX_TYPE_CHOICES_PER_FILE;
/** Issues listed in a report; `issueCount` stays exact. */
export const MAX_BOX_TYPE_ISSUES_LISTED = 200;
/** Characters of the type text next to a box (viewer and DXF); longer descriptions are cut. */
export const BOX_TYPE_LABEL_MAX = 80;
/** Layer of the type texts in the downloaded DXF. */
export const BOX_TYPE_DXF_LAYER = 'BOX_TYPE';

const noControl = (value: string) => ![...value].some((char) => char.charCodeAt(0) < 0x20);
const Handle = z.string().min(1).max(64).refine(noControl, 'Control characters are not allowed');
const Actor = z.object({ id: z.uuid(), name: z.string() });
/** Normalized preview space: the shape centred on 0,0, its larger side 1 (so |v| ≤ 0.5). */
const Unit = z.number().refine(Number.isFinite, 'Must be a finite number').min(-1).max(1);

// ---------- preview and gallery (worker output) ----------

/**
 * A small picture of a shape in normalized units (y up; the web flips it), drawn by the web as
 * canvas / SVG elements — never injected as markup. Paths are flat [x0, y0, x1, y1, …].
 */
export const BoxShapePreviewSchema = z
  .object({
    paths: z
      .array(
        z
          .array(Unit)
          .min(4)
          .refine((p) => p.length % 2 === 0, 'Expected x, y pairs'),
      )
      .max(MAX_BOX_SHAPE_PREVIEW_PATHS),
    /** Texts drawn inside the symbol (a block's constant texts; a `text` rule's text). */
    texts: z
      .array(
        z.object({
          x: Unit,
          y: Unit,
          height: z.number().positive().max(1),
          rotation: z.number().refine(Number.isFinite, 'Must be a finite number'),
          text: z.string().max(MAX_BOX_SHAPE_PREVIEW_TEXT_LENGTH),
        }),
      )
      .max(MAX_BOX_SHAPE_PREVIEW_TEXTS),
    /** Vertices were capped: the picture is simplified. */
    truncated: z.boolean(),
  })
  .refine(
    (p) => p.paths.reduce((n, path) => n + path.length / 2, 0) <= MAX_BOX_SHAPE_PREVIEW_VERTICES,
    'Too many preview vertices',
  );
export type BoxShapePreview = z.infer<typeof BoxShapePreviewSchema>;

export const BoxShapeSchema = z.object({
  shape: BoxShapeSignatureSchema,
  source: BoxShapeSourceSchema,
  /** Boxes of the revision with this shape. */
  count: z.number().int().min(1),
  /** Block names drawing this shape (information only; the shape, not the name, groups). */
  blockNames: z.array(z.string().max(255)).max(MAX_BOX_SHAPE_BLOCK_NAMES),
  /** `sourceHandle`s of the first boxes (handle order), for «اعرض على الرسمة». */
  sampleHandles: z.array(Handle).min(1).max(MAX_BOX_SHAPE_SAMPLES),
  /** null: `none`, or the file's preview cap was reached (zoom to a sample on the viewer). */
  preview: BoxShapePreviewSchema.nullable(),
});
export type BoxShape = z.infer<typeof BoxShapeSchema>;

/**
 * `design_revisions.box_shapes`, written by the worker when it builds a roles-mode Secondary
 * (null otherwise and on revisions built before migration 0023). Shapes sorted by count
 * (descending) then signature; at most MAX_BOX_SHAPES listed, `shapeCount` exact.
 */
export const BoxShapeGallerySchema = z
  .object({
    version: z.number().int().min(1),
    /** Every box of the revision. */
    boxCount: z.number().int().min(0),
    /** Distinct shapes, exact (may exceed the listed ones). */
    shapeCount: z.number().int().min(0),
    shapes: z.array(BoxShapeSchema).max(MAX_BOX_SHAPES),
    /** Boxes whose insert has no signature (file processed before 0023): reprocess the file. */
    boxesWithoutShape: z.number().int().min(0),
  })
  .refine((g) => new Set(g.shapes.map((s) => s.shape)).size === g.shapes.length, 'Duplicate shape');
export type BoxShapeGallery = z.infer<typeof BoxShapeGallerySchema>;

// ---------- the PM's choices (per Secondary CAD file, append-only) ----------

/**
 * POST /projects/:p/cad-files/:f/box-types — one or many choices in one transaction (one shape, or
 * «use the previous version's choices»). `workOrderLineId` null clears the shape back to unset.
 * A choice equal to the one in force writes nothing. Shapes must be in the gallery of the file's
 * latest built revision (draft or published); lines must be lines of the project's work order.
 */
export const SetBoxTypesRequestSchema = z.strictObject({
  choices: z
    .array(
      z.strictObject({
        shape: BoxShapeSignatureSchema,
        workOrderLineId: z.uuid().nullable(),
      }),
    )
    .min(1)
    .max(MAX_BOX_SHAPES)
    .refine((c) => new Set(c.map((x) => x.shape)).size === c.length, 'Duplicate shape'),
  /** The PM pressed «use the previous version's choices» (recorded in the events only). */
  fromPreviousVersion: z.boolean().default(false),
});
export type SetBoxTypesRequest = z.infer<typeof SetBoxTypesRequestSchema>;

/** One row of `cad_file_box_type_choices` (never updated or deleted; the latest per shape counts). */
export const BoxTypeChoiceSchema = z.object({
  id: z.uuid(),
  cadFileId: z.uuid(),
  shape: BoxShapeSignatureSchema,
  /** `work_order_items.id`; null = cleared. */
  workOrderLineId: z.uuid().nullable(),
  createdBy: Actor.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type BoxTypeChoice = z.infer<typeof BoxTypeChoiceSchema>;

/**
 * GET (and the answer of POST) /projects/:p/cad-files/:f/box-types — the live state of the file
 * (what the next build freezes). For a General `applies` is false and everything is empty.
 */
export const BoxTypeStateSchema = z.object({
  cadFileId: z.uuid(),
  drawingKind: DrawingKindSchema,
  applies: z.boolean(),
  /** In force: the latest row per shape, with a line (cleared shapes are left out). */
  active: z.array(BoxTypeChoiceSchema).max(MAX_BOX_TYPE_CHOICES_PER_FILE),
  /** Every row, newest first. */
  history: z.array(BoxTypeChoiceSchema).max(MAX_BOX_TYPE_CHOICE_ROWS_PER_FILE),
  /**
   * The choices in force on the previous version of this Secondary (ADR-038 new version), offered
   * as «use the previous choices»; never applied without the PM. null = no previous version.
   */
  previousVersion: z
    .object({
      cadFileId: z.uuid(),
      choices: z
        .array(z.object({ shape: BoxShapeSignatureSchema, workOrderLineId: z.uuid() }))
        .max(MAX_BOX_TYPE_CHOICES_PER_FILE),
    })
    .nullable(),
});
export type BoxTypeState = z.infer<typeof BoxTypeStateSchema>;

/**
 * `details.reason` of refused box-type writes:
 * - NOT_SECONDARY_DRAWING (409): the file is a General;
 * - FILE_SUPERSEDED (409): a newer version of the Secondary exists; choose on that one;
 * - NOT_BUILT (409): no built revision (draft / published) of this file with a gallery yet;
 * - NO_WORK_ORDER (409): the project has no work order (create / import it first);
 * - SHAPE_NOT_FOUND (422, `details.shapes`): not a shape of the latest built revision's gallery;
 * - LINE_NOT_IN_WORK_ORDER (422, `details.workOrderLineIds`): not a line of this project's work order;
 * - TOO_MANY_CHOICES (409): technical caps reached.
 */
export const BOX_TYPE_WRITE_REFUSALS = [
  'NOT_SECONDARY_DRAWING',
  'FILE_SUPERSEDED',
  'NOT_BUILT',
  'NO_WORK_ORDER',
  'SHAPE_NOT_FOUND',
  'LINE_NOT_IN_WORK_ORDER',
  'TOO_MANY_CHOICES',
] as const;
export type BoxTypeWriteRefusal = (typeof BOX_TYPE_WRITE_REFUSALS)[number];

/** Rows newest first → the latest row per shape (cleared shapes included, `workOrderLineId` null). */
export function latestChoicePerShape<T extends { shape: string }>(newestFirst: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of newestFirst) {
    if (seen.has(row.shape)) continue;
    seen.add(row.shape);
    out.push(row);
  }
  return out;
}

// ---------- frozen on the revision ----------

/**
 * The type text next to a box: the work-order line's description (copied from the contract,
 * ADR-028), whitespace collapsed, cut to BOX_TYPE_LABEL_MAX with «…». The code is kept apart
 * (shown LTR next to it).
 */
export function boxTypeLabel(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  return text.length <= BOX_TYPE_LABEL_MAX ? text : `${text.slice(0, BOX_TYPE_LABEL_MAX - 1)}…`;
}

export const FrozenBoxTypeLineSchema = z.object({
  code: z.string().max(64),
  description: z.string().max(2000),
  label: z.string().max(BOX_TYPE_LABEL_MAX),
});
export type FrozenBoxTypeLine = z.infer<typeof FrozenBoxTypeLineSchema>;

export const FrozenBoxTypeSchema = z.object({
  /** The choice row in force at creation. */
  choiceId: z.uuid(),
  shape: BoxShapeSignatureSchema,
  workOrderLineId: z.uuid(),
  /** Snapshot of the line at creation; null when it no longer existed (BOX_TYPE_LINE_MISSING). */
  line: FrozenBoxTypeLineSchema.nullable(),
});
export type FrozenBoxType = z.infer<typeof FrozenBoxTypeSchema>;

/**
 * `design_revisions.box_types`, frozen at creation for a Secondary (null for a General and for
 * revisions built before migration 0023): the choices in force with a line, in shape order. A
 * later choice needs a new build («طبّق وابنِ من جديد»), like corrections.
 */
export const FrozenBoxTypesSchema = z.object({
  choices: z
    .array(FrozenBoxTypeSchema)
    .max(MAX_BOX_TYPE_CHOICES_PER_FILE)
    .refine((c) => new Set(c.map((x) => x.shape)).size === c.length, 'Duplicate shape'),
});
export type FrozenBoxTypes = z.infer<typeof FrozenBoxTypesSchema>;

/** The live choices in force (with a line) differ from what a revision froze: rebuild. */
export function boxTypesChangedSince(
  frozen: FrozenBoxTypes | null,
  liveActiveChoiceIds: readonly string[],
): boolean {
  const frozenIds = new Set((frozen?.choices ?? []).map((c) => c.choiceId));
  if (frozenIds.size !== liveActiveChoiceIds.length) return true;
  return liveActiveChoiceIds.some((id) => !frozenIds.has(id));
}

/** What the worker writes on each box (`attrs.reading.boxType`), from the frozen choices. */
export const BoxTypeOnBoxSchema = z.object({
  workOrderLineId: z.uuid(),
  code: z.string().max(64).nullable(),
  label: z.string().max(BOX_TYPE_LABEL_MAX).nullable(),
});
export type BoxTypeOnBox = z.infer<typeof BoxTypeOnBoxSchema>;

// ---------- evaluation (readiness, publish, part H) ----------

/**
 * Why a Secondary's box types are unclear (each blocks publishing):
 * - READING_ROLES_MISSING: the Secondary is mapped without «معنى النصوص» (legacy reading mode), so
 *   box types and the ADR-041 checks would silently not apply: set the text roles and rebuild;
 * - WORK_ORDER_MISSING: the project has no work order, so no type can be chosen;
 * - BOX_SHAPES_NOT_READ: the revision has no gallery (built before 0023): rebuild;
 * - BOX_SHAPE_UNKNOWN: boxes whose shape was not read (file processed before 0023): reprocess the
 *   file, then rebuild;
 * - BOX_SHAPES_TOO_MANY: more distinct shapes than MAX_BOX_SHAPES: unify the symbols in AutoCAD;
 * - BOX_TYPE_UNSET: a shape with boxes and no line chosen (one issue per shape);
 * - BOX_TYPE_LINE_MISSING: the chosen line is no longer a line of the project's work order.
 */
export const BOX_TYPE_ISSUE_CODES = [
  'READING_ROLES_MISSING',
  'WORK_ORDER_MISSING',
  'BOX_SHAPES_NOT_READ',
  'BOX_SHAPE_UNKNOWN',
  'BOX_SHAPES_TOO_MANY',
  'BOX_TYPE_UNSET',
  'BOX_TYPE_LINE_MISSING',
] as const;
export const BoxTypeIssueCodeSchema = z.enum(BOX_TYPE_ISSUE_CODES);
export type BoxTypeIssueCode = z.infer<typeof BoxTypeIssueCodeSchema>;

export const BoxTypeIssueSchema = z.object({
  code: BoxTypeIssueCodeSchema,
  shape: BoxShapeSignatureSchema.nullable(),
  /** Boxes concerned (null for WORK_ORDER_MISSING / BOX_SHAPES_NOT_READ). */
  boxCount: z.number().int().min(0).nullable(),
  workOrderLineId: z.uuid().nullable(),
});
export type BoxTypeIssue = z.infer<typeof BoxTypeIssueSchema>;

/** Boxes per work-order line for the quantities (ADR-040 part H); derived, never stored. */
export const BoxTypeTotalSchema = z.object({
  workOrderLineId: z.uuid(),
  code: z.string().nullable(),
  label: z.string().nullable(),
  boxCount: z.number().int().min(1),
  shapes: z.array(BoxShapeSignatureSchema).min(1),
});
export type BoxTypeTotal = z.infer<typeof BoxTypeTotalSchema>;

/**
 * GET …/design-revisions/:r/box-types and `PublishReadiness.boxTypes`. `changedSinceBuild` is set by
 * the API from the live choices (`boxTypesChangedSince`); false when not applicable.
 */
export const BoxTypesReportSchema = z.object({
  applies: z.boolean(),
  gallery: BoxShapeGallerySchema.nullable(),
  frozen: FrozenBoxTypesSchema.nullable(),
  ok: z.boolean(),
  issueCount: z.number().int().min(0),
  issues: z.array(BoxTypeIssueSchema).max(MAX_BOX_TYPE_ISSUES_LISTED),
  /** null whenever not ok (or not applicable). */
  totals: z.array(BoxTypeTotalSchema).nullable(),
  changedSinceBuild: z.boolean(),
});
export type BoxTypesReport = z.infer<typeof BoxTypesReportSchema>;

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The box-type check of one revision (pure; API readiness, publish and part H use it). Not
 * applicable → ok. Issues in BOX_TYPE_ISSUE_CODES order then shape; totals only when ok.
 */
export function evaluateBoxTypes(input: {
  applies: boolean;
  /**
   * A Secondary read in legacy mode (no text roles): one READING_ROLES_MISSING issue, `applies`
   * becomes true, nothing else is evaluated. Ignored when false/absent.
   */
  rolesMissing?: boolean;
  gallery: BoxShapeGallery | null;
  frozen: FrozenBoxTypes | null;
  /** The project has a work order. */
  workOrderExists: boolean;
  /** Ids of the lines of the project's work order NOW (not at build). */
  workOrderLineIds: ReadonlySet<string>;
}): Omit<BoxTypesReport, 'changedSinceBuild'> {
  const { applies, gallery, frozen, workOrderExists, workOrderLineIds } = input;
  if (input.rolesMissing) {
    return {
      applies: true,
      gallery: null,
      frozen: null,
      ok: false,
      issueCount: 1,
      issues: [
        { code: 'READING_ROLES_MISSING', shape: null, boxCount: null, workOrderLineId: null },
      ],
      totals: null,
    };
  }
  if (!applies) {
    return {
      applies: false,
      gallery: null,
      frozen: null,
      ok: true,
      issueCount: 0,
      issues: [],
      totals: null,
    };
  }
  const issues: BoxTypeIssue[] = [];
  const issue = (code: BoxTypeIssueCode, more: Partial<Omit<BoxTypeIssue, 'code'>> = {}) =>
    issues.push({ code, shape: null, boxCount: null, workOrderLineId: null, ...more });

  if (!workOrderExists) issue('WORK_ORDER_MISSING');
  const byShape = new Map((frozen?.choices ?? []).map((c) => [c.shape, c]));
  const groups = new Map<string, BoxTypeTotal>();

  if (gallery === null) {
    issue('BOX_SHAPES_NOT_READ');
  } else {
    if (gallery.boxesWithoutShape > 0) {
      issue('BOX_SHAPE_UNKNOWN', { boxCount: gallery.boxesWithoutShape });
    }
    const listed = gallery.shapes.reduce((n, s) => n + s.count, 0);
    if (gallery.shapeCount > gallery.shapes.length) {
      issue('BOX_SHAPES_TOO_MANY', {
        boxCount: Math.max(0, gallery.boxCount - gallery.boxesWithoutShape - listed),
      });
    }
    for (const s of gallery.shapes) {
      const choice = byShape.get(s.shape);
      if (!choice) {
        issue('BOX_TYPE_UNSET', { shape: s.shape, boxCount: s.count });
        continue;
      }
      if (!workOrderLineIds.has(choice.workOrderLineId)) {
        issue('BOX_TYPE_LINE_MISSING', {
          shape: s.shape,
          boxCount: s.count,
          workOrderLineId: choice.workOrderLineId,
        });
        continue;
      }
      const total = groups.get(choice.workOrderLineId) ?? {
        workOrderLineId: choice.workOrderLineId,
        code: choice.line?.code ?? null,
        label: choice.line?.label ?? null,
        boxCount: 0,
        shapes: [],
      };
      total.boxCount += s.count;
      total.shapes.push(s.shape);
      groups.set(choice.workOrderLineId, total);
    }
  }

  const order = (code: BoxTypeIssueCode) => BOX_TYPE_ISSUE_CODES.indexOf(code);
  issues.sort((a, b) => order(a.code) - order(b.code) || byString(a.shape ?? '', b.shape ?? ''));
  const ok = issues.length === 0;
  const totals = ok
    ? [...groups.values()]
        .map((t) => ({ ...t, shapes: [...t.shapes].sort(byString) }))
        .sort(
          (a, b) =>
            byString(a.code ?? '', b.code ?? '') || byString(a.workOrderLineId, b.workOrderLineId),
        )
    : null;
  return {
    applies: true,
    gallery,
    frozen,
    ok,
    issueCount: issues.length,
    issues: issues.slice(0, MAX_BOX_TYPE_ISSUES_LISTED),
    totals,
  };
}
