/**
 * A point in the project CRS (metric, e.g. UTM 36N). Never WGS84: lengths and
 * snap distances are computed in metres directly on these coordinates.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Polyline = readonly Point[];

export const GEOMETRY_ERROR_CODES = [
  'NON_FINITE_COORDINATE',
  'TOO_FEW_VERTICES',
  'VERTEX_OUT_OF_RANGE',
  'INVALID_TOLERANCE',
] as const;
export type GeometryErrorCode = (typeof GEOMETRY_ERROR_CODES)[number];

export class GeometryError extends Error {
  constructor(
    readonly code: GeometryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeometryError';
  }
}

export function point(x: number, y: number): Point {
  const p = { x, y };
  assertFinitePoint(p);
  return p;
}

export function assertFinitePoint(p: Point): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new GeometryError('NON_FINITE_COORDINATE', `Coordinate is not finite: (${p.x}, ${p.y})`);
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function translatePoint(p: Point, dx: number, dy: number): Point {
  return point(p.x + dx, p.y + dy);
}
