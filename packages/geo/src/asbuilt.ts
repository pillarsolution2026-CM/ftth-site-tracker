import { assertFinitePoint, GeometryError, type Point, type Polyline } from './point.js';
import { MIN_POLYLINE_VERTICES } from './polyline.js';

/** `[x, y]` in project-CRS metres, as the sync contracts carry coordinates. */
export type XY = readonly [number, number];

/**
 * The route an editing session ends with, in the form the As-Built contract accepts (ADR-030):
 * consecutive equal vertices removed (a grip dropped onto its neighbour, a double tap while
 * drawing). Zero-length segments add nothing to the length, so the length is unchanged.
 * Throws `TOO_FEW_VERTICES` when fewer than two distinct vertices remain.
 */
export function toAsBuiltRoute(line: Polyline): Polyline {
  const result: Point[] = [];
  for (const p of line) {
    assertFinitePoint(p);
    const last = result[result.length - 1];
    if (last === undefined || last.x !== p.x || last.y !== p.y) result.push(p);
  }
  if (result.length < MIN_POLYLINE_VERTICES) {
    throw new GeometryError(
      'TOO_FEW_VERTICES',
      `A route needs at least ${MIN_POLYLINE_VERTICES} distinct vertices, got ${result.length}`,
    );
  }
  return result;
}

export function routeFromCoordinates(coordinates: readonly XY[]): Polyline {
  return coordinates.map(([x, y]) => {
    const p = { x, y };
    assertFinitePoint(p);
    return p;
  });
}

export function routeToCoordinates(line: Polyline): [number, number][] {
  return line.map((p) => [p.x, p.y]);
}

/** Exact equality: true when a session ended where it started (nothing to send). */
export function sameRoute(a: Polyline, b: Polyline): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i]?.x && p.y === b[i]?.y);
}
