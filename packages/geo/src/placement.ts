import proj4 from 'proj4';
import { createProjectCrs, utmProj4Definition, utmZoneFromEpsg } from './crs.js';
import { GeometryError, type Point } from './point.js';

/**
 * Placing a drawing on the earth (ADR-032, ADR-035). Pure. Mirror of
 * `workers/cad/cad_worker/domain/placement.py` — change both together (shared test values).
 *
 * drawing units → metres → source CRS → project UTM → control-point fit → hand adjustment.
 * A fit and a hand adjustment are similarities: X = a·x − b·y + tx, Y = b·x + a·y + ty.
 */

/** Egypt 1907 / Red Belt, general datum shift (mirror of `EGYPT_RED_BELT_PROJ4` in @ftth/shared). */
export const EGYPT_RED_BELT_PROJ4 =
  '+proj=tmerc +lat_0=30 +lon_0=31 +k=1 +x_0=615000 +y_0=810000 +ellps=helmert ' +
  '+towgs84=-130,110,-13,0,0,0,0 +units=m +no_defs';

export type SourceCrs = 'project' | 'egypt_red_belt';

export interface Similarity {
  readonly a: number;
  readonly b: number;
  readonly tx: number;
  readonly ty: number;
}

export const IDENTITY: Similarity = { a: 1, b: 0, tx: 0, ty: 0 };

export function applySimilarity(s: Similarity, p: Point): Point {
  return { x: s.a * p.x - s.b * p.y + s.tx, y: s.b * p.x + s.a * p.y + s.ty };
}

/** `outer ∘ inner`: apply `inner` first. */
export function composeSimilarity(outer: Similarity, inner: Similarity): Similarity {
  return {
    a: outer.a * inner.a - outer.b * inner.b,
    b: outer.b * inner.a + outer.a * inner.b,
    tx: outer.a * inner.tx - outer.b * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.a * inner.ty + outer.ty,
  };
}

export const scaleOf = (s: Similarity): number => Math.hypot(s.a, s.b);
export const rotationDegOf = (s: Similarity): number => (Math.atan2(s.b, s.a) * 180) / Math.PI;

export interface PlacementPointInput {
  readonly id: string;
  /** Drawing units. */
  readonly drawing: Point;
  readonly lat: number;
  readonly lon: number;
  readonly excluded: boolean;
}

export interface PlacementAdjustInput {
  readonly dx: number;
  readonly dy: number;
  readonly rotationDeg: number;
  readonly scale: number;
  readonly pivot: Point | null;
}

export interface PlacementInput {
  readonly projectEpsg: number;
  readonly metresPerUnit: number;
  readonly sourceCrs: SourceCrs;
  readonly points: readonly PlacementPointInput[];
  readonly fitScaleWithTwoPoints: boolean;
  readonly adjust: PlacementAdjustInput;
}

export interface PointResidual {
  readonly id: string;
  /** Distance in metres between where the point lands and its Lat/Lon. */
  readonly errorM: number;
  readonly excluded: boolean;
  /** Far from the others (3+ points used): the user may leave it out. */
  readonly outlier: boolean;
}

export interface PlacementSolution {
  /** Control-point fit, applied after the source CRS conversion. */
  readonly fit: Similarity;
  /** Hand adjustment, applied after the fit. */
  readonly adjust: Similarity;
  /** `adjust ∘ fit`. */
  readonly total: Similarity;
  readonly pointsUsed: number;
  readonly scale: number;
  readonly rotationDeg: number;
  /** |scale − 1| > 0.1 %: warned before saving (ADR-032). */
  readonly scaleWarning: boolean;
  readonly residuals: readonly PointResidual[];
  /** Drawing units → project CRS metres. */
  toProject(p: Point): Point;
}

export const SCALE_WARNING = 0.001;
// Technical tuning, not business rules: a used point is an outlier when its error is more than
// OUTLIER_FACTOR × the median error of the used points and above OUTLIER_MIN_M.
export const OUTLIER_FACTOR = 3;
export const OUTLIER_MIN_M = 2;

/** Drawing units → metres in the project CRS before any fit (unit factor + source conversion). */
export function sourceToProject(
  sourceCrs: SourceCrs,
  projectEpsg: number,
  metresPerUnit: number,
): (p: Point) => Point {
  const toMetres = (p: Point): Point => ({ x: p.x * metresPerUnit, y: p.y * metresPerUnit });
  if (sourceCrs === 'project') return toMetres;
  const converter = proj4(EGYPT_RED_BELT_PROJ4, utmProj4Definition(utmZoneFromEpsg(projectEpsg)));
  return (p) => {
    const m = toMetres(p);
    const [x, y] = converter.forward([m.x, m.y]) as [number, number];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new GeometryError('NON_FINITE_COORDINATE', 'Red Belt conversion failed');
    }
    return { x, y };
  };
}

/** Least-squares similarity mapping `from` onto `to`; `withScale` false keeps scale 1. */
export function fitSimilarity(
  from: readonly Point[],
  to: readonly Point[],
  withScale: boolean,
): Similarity {
  const n = from.length;
  if (n === 0) return IDENTITY;
  const fm = mean(from);
  const tm = mean(to);
  if (n === 1) return { a: 1, b: 0, tx: tm.x - fm.x, ty: tm.y - fm.y };
  let num_a = 0;
  let num_b = 0;
  let den = 0;
  from.forEach((f, i) => {
    const t = to[i] ?? tm;
    const fx = f.x - fm.x;
    const fy = f.y - fm.y;
    const tx = t.x - tm.x;
    const ty = t.y - tm.y;
    num_a += fx * tx + fy * ty;
    num_b += fx * ty - fy * tx;
    den += fx * fx + fy * fy;
  });
  if (den === 0) throw new GeometryError('DEGENERATE', 'Control points sit on one drawing spot');
  let a = num_a / den;
  let b = num_b / den;
  if (!withScale) {
    const k = Math.hypot(a, b);
    a /= k;
    b /= k;
  }
  return { a, b, tx: tm.x - (a * fm.x - b * fm.y), ty: tm.y - (b * fm.x + a * fm.y) };
}

export function adjustSimilarity(adjust: PlacementAdjustInput): Similarity {
  const turns = adjust.rotationDeg !== 0 || adjust.scale !== 1;
  const t = (adjust.rotationDeg * Math.PI) / 180;
  const a = adjust.scale * Math.cos(t);
  const b = adjust.scale * Math.sin(t);
  const c = turns ? adjust.pivot : { x: 0, y: 0 };
  if (!c) throw new GeometryError('DEGENERATE', 'Rotate / Scale need a pivot');
  // Turn about the pivot, then move.
  return {
    a,
    b,
    tx: c.x - (a * c.x - b * c.y) + adjust.dx,
    ty: c.y - (b * c.x + a * c.y) + adjust.dy,
  };
}

export function solvePlacement(input: PlacementInput): PlacementSolution {
  const toSource = sourceToProject(input.sourceCrs, input.projectEpsg, input.metresPerUnit);
  const project = createProjectCrs(input.projectEpsg);
  const all = input.points.map((p) => ({
    p,
    from: toSource(p.drawing),
    to: project.fromWgs84({ lon: p.lon, lat: p.lat }),
  }));
  const used = all.filter((x) => !x.p.excluded);
  const withScale = used.length >= 3 || (used.length === 2 && input.fitScaleWithTwoPoints);
  const fit = fitSimilarity(
    used.map((x) => x.from),
    used.map((x) => x.to),
    withScale,
  );
  const adjust = adjustSimilarity(input.adjust);
  const total = composeSimilarity(adjust, fit);
  const measured = all.map((x) => ({ x, errorM: distance(applySimilarity(fit, x.from), x.to) }));
  const usedErrors = measured.filter((m) => !m.x.p.excluded).map((m) => m.errorM);
  const limit =
    used.length >= 3 ? Math.max(OUTLIER_FACTOR * median(usedErrors), OUTLIER_MIN_M) : Infinity;
  const scale = scaleOf(total);
  return {
    fit,
    adjust,
    total,
    pointsUsed: used.length,
    scale,
    rotationDeg: rotationDegOf(total),
    scaleWarning: Math.abs(scale - 1) > SCALE_WARNING,
    residuals: measured.map(({ x, errorM }) => ({
      id: x.p.id,
      errorM,
      excluded: x.p.excluded,
      outlier: !x.p.excluded && errorM > limit,
    })),
    toProject: (p) => applySimilarity(total, toSource(p)),
  };
}

function mean(ps: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ps) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ps.length, y: y / ps.length };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((p, q) => p - q);
  const m = Math.floor(s.length / 2);
  const hi = s[m] ?? 0;
  return s.length % 2 ? hi : ((s[m - 1] ?? hi) + hi) / 2;
}

const distance = (p: Point, q: Point): number => Math.hypot(p.x - q.x, p.y - q.y);
