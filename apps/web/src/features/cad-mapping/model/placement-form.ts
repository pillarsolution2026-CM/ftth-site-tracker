import { createProjectCrs, solvePlacement, type PlacementSolution, type Point } from '@ftth/geo';
import {
  PlacementSchema,
  type CadMappingView,
  type ControlPoint,
  type Placement,
  type PlacementAdjust,
  type PlacementSourceCrs,
} from '@ftth/shared';

/**
 * Editable placement of the drawing (ADR-035): source CRS, control points, hand adjustment.
 * Saved with the mapping and frozen on the next revision; the drawing file never changes.
 */
export interface PlacementFormState {
  sourceCrs: PlacementSourceCrs;
  points: ControlPoint[];
  fitScaleWithTwoPoints: boolean;
  adjust: PlacementAdjust;
}

export const NEUTRAL_ADJUST: PlacementAdjust = {
  dx: 0,
  dy: 0,
  rotationDeg: 0,
  scale: 1,
  pivot: null,
};

/** Hand scale is limited like the contract (`PlacementAdjustSchema`). */
export const MIN_HAND_SCALE = 0.5;
export const MAX_HAND_SCALE = 2;

/**
 * The saved placement; on a first visit (no saved mapping) the detected source CRS is suggested,
 * e.g. Red Belt for a drawing whose coordinates read as Egypt 1907 (ADR-035).
 */
export function initialPlacementState(view: CadMappingView): PlacementFormState {
  const saved = view.mapping?.placement;
  if (saved) {
    return {
      sourceCrs: saved.sourceCrs,
      points: saved.points.map((point) => ({ ...point })),
      fitScaleWithTwoPoints: saved.fitScaleWithTwoPoints,
      adjust: { ...saved.adjust },
    };
  }
  const suggested = view.mapping ? null : view.crsDetection?.suggestedSourceCrs;
  return {
    sourceCrs: suggested === 'egypt_red_belt' ? 'egypt_red_belt' : 'project',
    points: [],
    fitScaleWithTwoPoints: false,
    adjust: { ...NEUTRAL_ADJUST },
  };
}

const isNeutral = (adjust: PlacementAdjust) =>
  adjust.dx === 0 && adjust.dy === 0 && adjust.rotationDeg === 0 && adjust.scale === 1;

/** The payload's `placement`: null when the drawing is used as drawn (nothing to apply). */
export function toPlacement(state: PlacementFormState): Placement | null {
  if (state.sourceCrs === 'project' && state.points.length === 0 && isNeutral(state.adjust)) {
    return null;
  }
  const adjust = isNeutral(state.adjust) ? { ...NEUTRAL_ADJUST } : state.adjust;
  const parsed = PlacementSchema.safeParse({ ...state, adjust });
  return parsed.success ? parsed.data : null;
}

/** Stable text of the placement, for the form's "unsaved changes" check. */
export function placementSignature(state: PlacementFormState): string {
  return JSON.stringify(toPlacement(state));
}

export type PlacementSolved =
  { ok: true; solution: PlacementSolution } | { ok: false; error: 'degenerate' | 'conversion' };

/** Solves the placement in the browser, exactly as the worker will at build (shared test values). */
export function solveState(
  state: PlacementFormState,
  projectEpsg: number,
  metresPerUnit: number,
): PlacementSolved {
  try {
    return {
      ok: true,
      solution: solvePlacement({
        projectEpsg,
        metresPerUnit,
        sourceCrs: state.sourceCrs,
        points: state.points,
        fitScaleWithTwoPoints: state.fitScaleWithTwoPoints,
        adjust: state.adjust,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      error: /pivot|one drawing spot/.test(message) ? 'degenerate' : 'conversion',
    };
  }
}

/** Move tool: shifts the drawing by (dx, dy) metres in the project CRS. */
export function moveAdjust(adjust: PlacementAdjust, dx: number, dy: number): PlacementAdjust {
  return { ...adjust, dx: round(adjust.dx + dx, 3), dy: round(adjust.dy + dy, 3) };
}

/**
 * Rotate / Scale tools: turns the placed drawing by `deg` and scales it by `factor` about `about`
 * (project CRS), on top of the current hand adjustment. The adjustment keeps one pivot: with
 * A(x) = s·R(φ)(x − c) + c + d, the new one is k·s, φ + θ and d' = k·R(θ)(c + d − P) + P − c.
 */
export function turnAdjust(
  adjust: PlacementAdjust,
  about: Point,
  deg: number,
  factor: number,
): PlacementAdjust {
  const start = adjust.pivot ?? about;
  const c = { x: round(start.x, 3), y: round(start.y, 3) };
  const t = (deg * Math.PI) / 180;
  const scale = clamp(adjust.scale * factor, MIN_HAND_SCALE, MAX_HAND_SCALE);
  const k = scale / adjust.scale;
  const vx = c.x + adjust.dx - about.x;
  const vy = c.y + adjust.dy - about.y;
  const dx = k * (Math.cos(t) * vx - Math.sin(t) * vy) + about.x - c.x;
  const dy = k * (Math.sin(t) * vx + Math.cos(t) * vy) + about.y - c.y;
  return {
    dx: round(dx, 3),
    dy: round(dy, 3),
    rotationDeg: round(normaliseDeg(adjust.rotationDeg + deg), 6),
    scale: round(scale, 6),
    pivot: c,
  };
}

/** Angle in degrees from `from` to `to` as seen from `about` (counter-clockwise positive). */
export function angleBetween(about: Point, from: Point, to: Point): number {
  const a = Math.atan2(from.y - about.y, from.x - about.x);
  const b = Math.atan2(to.y - about.y, to.x - about.x);
  return normaliseDeg(((b - a) * 180) / Math.PI);
}

/** Ratio of the distances of `to` and `from` from `about` (1 when `from` sits on it). */
export function scaleBetween(about: Point, from: Point, to: Point): number {
  const d0 = Math.hypot(from.x - about.x, from.y - about.y);
  return d0 === 0 ? 1 : Math.hypot(to.x - about.x, to.y - about.y) / d0;
}

/** Lon/Lat of a project CRS point (for the map). */
export function projectToLonLat(projectEpsg: number) {
  const crs = createProjectCrs(projectEpsg);
  return (p: Point): [number, number] => {
    const { lon, lat } = crs.toWgs84(p);
    return [lon, lat];
  };
}

/** Project CRS point of a Lon/Lat (map pointer → metres). */
export function lonLatToProject(projectEpsg: number) {
  const crs = createProjectCrs(projectEpsg);
  return (lon: number, lat: number): Point => crs.fromWgs84({ lon, lat });
}

/** Next free id for a new control point ("P1", "P2", …). */
export function nextPointId(points: readonly ControlPoint[]): string {
  const used = new Set(points.map((point) => point.id));
  for (let n = 1; ; n += 1) if (!used.has(`P${n}`)) return `P${n}`;
}

function normaliseDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f || 0;
};
