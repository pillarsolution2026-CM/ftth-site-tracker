import { assertFinitePoint, distance, GeometryError, type Point, type Polyline } from './point.js';

/**
 * Arc and bulge flattening. Mirrors `workers/cad/cad_worker/domain/flatten.py`
 * (same formulas, tolerance and segment cap) so a route flattened on the
 * device has the same vertices as the one the worker imported.
 */

/** Maximum sagitta (chord-to-arc distance) in metres: 1 mm, as in the worker. */
export const FLATTEN_TOLERANCE_M = 0.001;
/** Cap per arc so a huge radius cannot create millions of vertices. */
export const MAX_ARC_SEGMENTS = 2048;

/** A DXF LWPOLYLINE vertex: bulge = tan(sweep / 4) of the segment to the next vertex; > 0 is counter-clockwise. */
export interface BulgeVertex extends Point {
  readonly bulge?: number;
}

export interface FlattenOptions {
  readonly closed?: boolean;
  readonly tolerance?: number;
}

export interface FlattenResult {
  readonly points: Polyline;
  /** True when at least one segment was an arc replaced by chords. */
  readonly approximated: boolean;
}

/** Number of chords so that no chord deviates from the arc by more than `tolerance`. */
export function arcSegmentCount(
  radius: number,
  sweep: number,
  tolerance: number = FLATTEN_TOLERANCE_M,
): number {
  assertTolerance(tolerance);
  if (radius <= 0 || sweep === 0) return 1;
  const ratio = 1 - tolerance / radius;
  const step = ratio <= -1 ? Math.PI : 2 * Math.acos(Math.max(ratio, -1));
  if (step <= 0) return MAX_ARC_SEGMENTS;
  return Math.max(1, Math.min(MAX_ARC_SEGMENTS, Math.ceil(Math.abs(sweep) / step)));
}

interface BulgeArc {
  readonly center: Point;
  readonly radius: number;
  readonly sweep: number;
}

function bulgeArc(a: Point, b: Point, bulge: number): BulgeArc | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (bulge === 0 || chord === 0) return null;
  const sweep = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  // Signed distance from the chord midpoint to the centre, along the chord's left normal.
  const offset = ((chord / 2) * (1 - bulge * bulge)) / (2 * bulge);
  const center = {
    x: (a.x + b.x) / 2 - (dy / chord) * offset,
    y: (a.y + b.y) / 2 + (dx / chord) * offset,
  };
  return { center, radius, sweep };
}

/** Points of one bulged segment, `a` … `b` inclusive (exact end points). */
export function bulgePoints(
  a: Point,
  b: Point,
  bulge: number,
  tolerance: number = FLATTEN_TOLERANCE_M,
): Polyline {
  assertFinitePoint(a);
  assertFinitePoint(b);
  assertBulge(bulge);
  const arc = bulgeArc(a, b, bulge);
  if (arc === null) return [a, b];
  const { center, radius, sweep } = arc;
  const n = arcSegmentCount(radius, sweep, tolerance);
  const start = Math.atan2(a.y - center.y, a.x - center.x);
  const points: Point[] = [a];
  for (let i = 1; i < n; i++) {
    const angle = start + (sweep * i) / n;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  points.push(b);
  return points;
}

/** Exact arc length of a bulged segment (the chord when the bulge is 0). */
export function bulgeSegmentLength(a: Point, b: Point, bulge: number): number {
  assertFinitePoint(a);
  assertFinitePoint(b);
  assertBulge(bulge);
  const arc = bulgeArc(a, b, bulge);
  return arc === null ? distance(a, b) : arc.radius * Math.abs(arc.sweep);
}

/** Flattens LWPOLYLINE vertices; a closed polyline gets its first point appended and its last bulge applied. */
export function flattenBulgePolyline(
  vertices: readonly BulgeVertex[],
  { closed = false, tolerance = FLATTEN_TOLERANCE_M }: FlattenOptions = {},
): FlattenResult {
  assertVertexCount(vertices);
  const points: Point[] = [];
  let approximated = false;
  for (const [a, b] of segmentsOf(vertices, closed)) {
    const segment = bulgePoints(a, b, a.bulge ?? 0, tolerance);
    approximated ||= segment.length > 2;
    points.push(...(points.length === 0 ? segment : segment.slice(1)));
  }
  return { points: points.map(({ x, y }) => ({ x, y })), approximated };
}

/** True length of a bulged polyline, before flattening. */
export function bulgePolylineLength(vertices: readonly BulgeVertex[], closed = false): number {
  assertVertexCount(vertices);
  let total = 0;
  for (const [a, b] of segmentsOf(vertices, closed))
    total += bulgeSegmentLength(a, b, a.bulge ?? 0);
  return total;
}

function* segmentsOf(
  vertices: readonly BulgeVertex[],
  closed: boolean,
): Generator<[BulgeVertex, BulgeVertex]> {
  const last = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < last; i++) {
    yield [vertices[i] as BulgeVertex, vertices[(i + 1) % vertices.length] as BulgeVertex];
  }
}

function assertVertexCount(vertices: readonly BulgeVertex[]): void {
  if (vertices.length < 2) {
    throw new GeometryError(
      'TOO_FEW_VERTICES',
      `A polyline needs at least 2 vertices, got ${vertices.length}`,
    );
  }
}

function assertBulge(bulge: number): void {
  if (!Number.isFinite(bulge))
    throw new GeometryError('INVALID_BULGE', `Bulge is not finite: ${bulge}`);
}

function assertTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new GeometryError('INVALID_TOLERANCE', `Invalid flatten tolerance: ${tolerance}`);
  }
}
