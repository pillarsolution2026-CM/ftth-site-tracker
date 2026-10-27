import { assertFinitePoint, distance, GeometryError, type Point, type Polyline } from './point.js';

/** A route needs a start and an end; anything shorter is not a polyline. */
export const MIN_POLYLINE_VERTICES = 2;

export function assertPolyline(line: Polyline): void {
  if (line.length < MIN_POLYLINE_VERTICES) {
    throw new GeometryError(
      'TOO_FEW_VERTICES',
      `A polyline needs at least ${MIN_POLYLINE_VERTICES} vertices, got ${line.length}`,
    );
  }
  line.forEach(assertFinitePoint);
}

/** Planar length in metres (project CRS), matching PostGIS `ST_Length` on the stored geometry. */
export function polylineLength(line: Polyline): number {
  assertPolyline(line);
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += distance(line[i - 1] as Point, line[i] as Point);
  }
  return total;
}

/** Closest point to `p` on segment `a`–`b`; a zero-length segment collapses to `a`. */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Shortest distance in metres from `p` to segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  return distance(p, closestPointOnSegment(p, a, b));
}

export function translatePolyline(line: Polyline, dx: number, dy: number): Polyline {
  assertPolyline(line);
  return line.map((p) => {
    const moved = { x: p.x + dx, y: p.y + dy };
    assertFinitePoint(moved);
    return moved;
  });
}
