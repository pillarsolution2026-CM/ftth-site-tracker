import { z } from 'zod';
import type { DrawingKind } from './drawing-kind.schemas.js';
import {
  ControlPointSchema,
  MAX_CONTROL_POINTS,
  PlacementSchema,
  type ControlPoint,
  type Placement,
  type PlacementSourceCrs,
} from './placement.schemas.js';
import { cabinetNameKey } from './text-roles.js';

/**
 * Automatic placement of a Secondary from the placed General (ADR-040 Q9, ADR-042 part G).
 * Each SUB cabinet name found once in both drawings gives one control point (`general_cabinet`):
 * - `drawing` = the Secondary cabinet's drawn centre in DRAWING units (`attrs.drawingAt` of its
 *   feature in the Secondary's latest built revision);
 * - `lat` / `lon` = the General cabinet's placed position (its feature `anchor`, project CRS, of
 *   the current General file's latest built revision) converted to WGS 84 by the API through
 *   `@ftth/geo` (`createProjectCrs(...).toWgs84`), as every control point is stored.
 * The error of each point is shown as ADR-035 (`solvePlacement`), far points are flagged and the PM
 * leaves them out (`excluded`) or adds / removes points by hand; the PM saves the placement on the
 * mapping as usual (map preview checked) and rebuilds. Nothing is guessed: names are matched by
 * `cabinetNameKey`, a name drawn twice on either side is not used, and without a built + placed
 * General the API refuses with a clear reason.
 * On Al-Fath the shared cabinets differ 6–8 m between the drawings (1-2: ~22 m): residuals show.
 */

// ---------- drawn centre stored on point features (worker, ADR-042) ----------

/**
 * `design_features.attrs.drawingAt` — a point feature's drawn centre in DRAWING units, after the
 * drawing corrections and before placement (the same point the placement screen lists, ADR-037).
 * Written by the worker on every point feature from ADR-042 on; absent on older revisions.
 */
export const DRAWING_AT_ATTR_KEY = 'drawingAt';
const Finite = z.number().refine(Number.isFinite, 'Must be a finite number');
export const DrawingAtSchema = z.object({ x: Finite, y: Finite });
export type DrawingAt = z.infer<typeof DrawingAtSchema>;

export function drawingAtOf(attrs: Readonly<Record<string, unknown>>): DrawingAt | null {
  const parsed = DrawingAtSchema.safeParse(attrs[DRAWING_AT_ATTR_KEY]);
  return parsed.success ? parsed.data : null;
}

// ---------- matching ----------

/** A General sub cabinet: its name (feature `code`) and its placed position in WGS 84. */
export interface GeneralCabinetPosition {
  name: string | null;
  lat: number;
  lon: number;
}

/** A Secondary sub cabinet: name, drawing handle (`source_handle`) and drawn centre. */
export interface SecondaryCabinetDrawn {
  name: string | null;
  handle: string;
  drawingAt: DrawingAt | null;
}

/** Most names listed per list; counts stay exact. */
export const MAX_SUGGESTION_NAMES_LISTED = 200;
const Names = z.array(z.string()).max(MAX_SUGGESTION_NAMES_LISTED);

export const SharedCabinetsUnmatchedSchema = z.object({
  /** Names in one drawing only (as written there), sorted by cabinetNameKey. */
  onlyInSecondary: Names,
  onlyInGeneral: Names,
  /** Names drawn more than once in a drawing (CABINET_NAME_DUPLICATE): not used. */
  duplicateInSecondary: Names,
  duplicateInGeneral: Names,
  unnamedSecondary: z.number().int().min(0),
  unnamedGeneral: z.number().int().min(0),
  /** Secondary cabinets with no `drawingAt` (built before ADR-042): rebuild the Secondary. */
  withoutDrawingPosition: Names,
  /** Matched names whose point could not be built (bad position or a name too long): not used. */
  unusable: Names.default([]),
  /** More cabinets than the API reads per drawing: the lists above are partial. */
  listCapped: z.boolean().default(false),
});
export type SharedCabinetsUnmatched = z.infer<typeof SharedCabinetsUnmatchedSchema>;

export const GENERAL_CABINET_POINT_ID_PREFIX = 'gc-';

/** Stable id of a cabinet's point, so a new suggestion replaces the old one (≤ 64 chars). */
export function generalCabinetPointId(name: string): string {
  const key = cabinetNameKey(name);
  const id = `${GENERAL_CABINET_POINT_ID_PREFIX}${key}`;
  if (id.length <= 64) return id;
  // Long names: a readable prefix plus a hash of the whole key, so two long names that share a
  // prefix never collide (PlacementSchema rejects duplicate ids).
  return `${id.slice(0, 47)}~${hash64(key)}`;
}

/** Two 32-bit FNV-1a lanes as 16 hex digits (deterministic, no crypto needed). */
function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function groupByName<T extends { name: string | null }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  let unnamed = 0;
  for (const item of items) {
    if (item.name === null || cabinetNameKey(item.name) === '') {
      unnamed += 1;
      continue;
    }
    const key = cabinetNameKey(item.name);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return { groups, unnamed };
}

/**
 * The suggested points, sorted by cabinetNameKey, at most MAX_CONTROL_POINTS (`truncated`), and
 * why the other cabinets gave none. Pure; the API feeds it from the two revisions.
 */
export function matchSharedCabinets(
  general: readonly GeneralCabinetPosition[],
  secondary: readonly SecondaryCabinetDrawn[],
): {
  points: ControlPoint[];
  matchedCount: number;
  truncated: boolean;
  unmatched: SharedCabinetsUnmatched;
} {
  const g = groupByName(general);
  const s = groupByName(secondary);
  const unmatched: SharedCabinetsUnmatched = {
    onlyInSecondary: [],
    onlyInGeneral: [],
    duplicateInSecondary: [],
    duplicateInGeneral: [],
    unnamedSecondary: s.unnamed,
    unnamedGeneral: g.unnamed,
    withoutDrawingPosition: [],
    unusable: [],
    listCapped: false,
  };
  const points: ControlPoint[] = [];
  const keys = [...new Set([...g.groups.keys(), ...s.groups.keys()])].sort(byKey);
  for (const key of keys) {
    const gs = g.groups.get(key) ?? [];
    const ss = s.groups.get(key) ?? [];
    const name = ss[0]?.name ?? gs[0]?.name ?? key;
    if (ss.length > 1) unmatched.duplicateInSecondary.push(name);
    if (gs.length > 1) unmatched.duplicateInGeneral.push(name);
    if (ss.length > 1 || gs.length > 1) continue;
    const [gc] = gs;
    const [sc] = ss;
    if (!sc) {
      unmatched.onlyInGeneral.push(name);
      continue;
    }
    if (!gc) {
      unmatched.onlyInSecondary.push(name);
      continue;
    }
    if (sc.drawingAt === null) {
      unmatched.withoutDrawingPosition.push(name);
      continue;
    }
    const point = ControlPointSchema.safeParse({
      id: generalCabinetPointId(name),
      drawing: sc.drawingAt,
      handle: sc.handle,
      label: name,
      lat: gc.lat,
      lon: gc.lon,
      source: 'general_cabinet',
      excluded: false,
    });
    if (point.success) points.push(point.data);
    else unmatched.unusable.push(name.slice(0, 200));
  }
  const cap = (list: string[]) => list.slice(0, MAX_SUGGESTION_NAMES_LISTED);
  return {
    points: points.slice(0, MAX_CONTROL_POINTS),
    matchedCount: points.length,
    truncated: points.length > MAX_CONTROL_POINTS,
    unmatched: {
      ...unmatched,
      onlyInSecondary: cap(unmatched.onlyInSecondary),
      onlyInGeneral: cap(unmatched.onlyInGeneral),
      duplicateInSecondary: cap(unmatched.duplicateInSecondary),
      duplicateInGeneral: cap(unmatched.duplicateInGeneral),
      withoutDrawingPosition: cap(unmatched.withoutDrawingPosition),
      unusable: cap(unmatched.unusable),
    },
  };
}

/**
 * Puts the suggested points into a placement (web, before the PM saves): earlier `general_cabinet`
 * points are replaced; the PM's other points (typed, KML, GPS) are kept first; a cabinet the PM had
 * left out (`excluded`) stays left out; points beyond MAX_CONTROL_POINTS are `dropped`.
 * `sourceCrsIfNew` is used only when there is no placement yet (the PM confirms it on the panel).
 */
export function withGeneralCabinetPoints(
  current: Placement | null,
  suggested: readonly ControlPoint[],
  sourceCrsIfNew: PlacementSourceCrs,
): { placement: Placement; dropped: number } {
  const base = current ?? PlacementSchema.parse({ sourceCrs: sourceCrsIfNew });
  const excludedBefore = new Set(
    base.points.filter((p) => p.source === 'general_cabinet' && p.excluded).map((p) => p.id),
  );
  const kept = base.points.filter((p) => p.source !== 'general_cabinet');
  const keptIds = new Set(kept.map((p) => p.id));
  const added = suggested
    .filter((p) => !keptIds.has(p.id))
    .map((p) => ({ ...p, excluded: p.excluded || excludedBefore.has(p.id) }));
  const room = Math.max(0, MAX_CONTROL_POINTS - kept.length);
  return {
    placement: { ...base, points: [...kept, ...added.slice(0, room)] },
    dropped: Math.max(0, added.length - room),
  };
}

/**
 * A `general_cabinet` point belongs to a Secondary only. The API refuses others on PUT …/mapping
 * (422, `details.reason` `POINT_SOURCE_NOT_FOR_KIND`, with the point indexes).
 */
export function placementKindProblems(placement: Placement | null, kind: DrawingKind): number[] {
  if (!placement || kind === 'secondary') return [];
  return placement.points.flatMap((p, index) => (p.source === 'general_cabinet' ? [index] : []));
}

// ---------- API ----------

/**
 * GET /projects/:p/cad-files/:f/placement/general-cabinets — `f` is the CURRENT Secondary file.
 * Sources:
 * - Secondary: the latest revision of `f` with status `draft` or `published` (its sub cabinets'
 *   `code` and `attrs.drawingAt`);
 * - General: the latest revision with status `draft` or `published` of the CURRENT General file,
 *   with a frozen placement having at least one control point in use (positions on the earth).
 * Read-only: nothing is saved; no event.
 */
export const SecondaryPlacementSuggestionSchema = z.object({
  cadFileId: z.uuid(),
  secondaryRevisionId: z.uuid(),
  general: z.object({
    cadFileId: z.uuid(),
    revisionId: z.uuid(),
    status: z.enum(['draft', 'published']),
    revNo: z.number().int().min(1).nullable(),
  }),
  /** `general_cabinet` points, sorted by cabinetNameKey, `excluded` false. */
  points: z.array(ControlPointSchema).max(MAX_CONTROL_POINTS),
  /** Shared cabinets that gave a point (may exceed `points.length` when `truncated`). */
  matchedCount: z.number().int().min(0),
  truncated: z.boolean(),
  unmatched: SharedCabinetsUnmatchedSchema,
});
export type SecondaryPlacementSuggestion = z.infer<typeof SecondaryPlacementSuggestionSchema>;

/**
 * 409 `details.reason` when no suggestion can be made (shown as a clear message; nothing guessed):
 * - NOT_SECONDARY: `f` is a General;
 * - NOT_CURRENT: `f` is superseded by a newer Secondary version;
 * - SECONDARY_BUILDING / GENERAL_BUILDING: the open revision is still queued or building;
 * - SECONDARY_NOT_BUILT: `f` has no draft / published revision (cabinet names come from a build);
 * - SECONDARY_REBUILD_NEEDED: its revision was built before ADR-042 (no `drawingAt`);
 * - GENERAL_NOT_BUILT: no current General file, or none of its revisions is draft / published;
 * - GENERAL_NOT_PLACED: that General revision has no placement with a control point in use.
 */
export const SECONDARY_PLACEMENT_REFUSALS = [
  'NOT_SECONDARY',
  'NOT_CURRENT',
  'SECONDARY_BUILDING',
  'SECONDARY_NOT_BUILT',
  'SECONDARY_REBUILD_NEEDED',
  'GENERAL_BUILDING',
  'GENERAL_NOT_BUILT',
  'GENERAL_NOT_PLACED',
] as const;
export const SecondaryPlacementRefusalSchema = z.enum(SECONDARY_PLACEMENT_REFUSALS);
export type SecondaryPlacementRefusal = z.infer<typeof SecondaryPlacementRefusalSchema>;

export const SecondaryPlacementRefusedDetailsSchema = z.object({
  reason: SecondaryPlacementRefusalSchema,
  /** The revision concerned when there is one (e.g. the unplaced General revision). */
  revisionId: z.uuid().nullable(),
});
export type SecondaryPlacementRefusedDetails = z.infer<
  typeof SecondaryPlacementRefusedDetailsSchema
>;
