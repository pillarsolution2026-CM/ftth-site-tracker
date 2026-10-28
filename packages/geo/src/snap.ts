import { assertFinitePoint, distance, GeometryError, type Point, type Polyline } from './point.js';

/** Snap radius on screen, from the plan («هامش 14px»); converted to metres at the current zoom. */
export const SNAP_TOLERANCE_PX = 14;

export type SnapKind = 'endpoint' | 'vertex' | 'symbol';

/** When two candidates are equally close, the earlier kind wins. */
const KIND_PRIORITY: Record<SnapKind, number> = { endpoint: 0, symbol: 1, vertex: 2 };

export type SnapTarget =
  | { readonly featureId: string; readonly kind: 'symbol'; readonly at: Point }
  | { readonly featureId: string; readonly kind: 'route'; readonly vertices: Polyline };

export interface SnapResult {
  readonly featureId: string;
  readonly kind: SnapKind;
  /** Set for endpoint/vertex snaps. */
  readonly vertexIndex?: number;
  readonly point: Point;
  readonly distance: number;
}

export interface SnapOptions {
  /**
   * What is being dragged, so it never snaps to itself: a whole feature
   * (moving a symbol) or one vertex of a route (dragging a grip).
   */
  readonly exclude?: { readonly featureId: string; readonly vertexIndex?: number };
}

export function toleranceFromPixels(pixels: number, metresPerPixel: number): number {
  const tolerance = pixels * metresPerPixel;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new GeometryError('INVALID_TOLERANCE', `Invalid snap tolerance: ${tolerance}`);
  }
  return tolerance;
}

/** Nearest endpoint, vertex or symbol within `toleranceM` of `cursor`, or null. */
export function snap(
  cursor: Point,
  targets: readonly SnapTarget[],
  toleranceM: number,
  options: SnapOptions = {},
): SnapResult | null {
  assertFinitePoint(cursor);
  if (!Number.isFinite(toleranceM) || toleranceM < 0) {
    throw new GeometryError('INVALID_TOLERANCE', `Invalid snap tolerance: ${toleranceM}`);
  }
  let best: SnapResult | null = null;
  for (const candidate of candidatesOf(targets, options)) {
    const d = distance(cursor, candidate.point);
    if (d > toleranceM) continue;
    const result = { ...candidate, distance: d };
    if (best === null || isBetter(result, best)) best = result;
  }
  return best;
}

function* candidatesOf(
  targets: readonly SnapTarget[],
  { exclude }: SnapOptions,
): Generator<Omit<SnapResult, 'distance'>> {
  for (const target of targets) {
    const isExcludedFeature = exclude?.featureId === target.featureId;
    if (target.kind === 'symbol') {
      if (!isExcludedFeature)
        yield { featureId: target.featureId, kind: 'symbol', point: target.at };
      continue;
    }
    if (isExcludedFeature && exclude.vertexIndex === undefined) continue;
    const last = target.vertices.length - 1;
    for (let vertexIndex = 0; vertexIndex <= last; vertexIndex++) {
      if (isExcludedFeature && exclude.vertexIndex === vertexIndex) continue;
      yield {
        featureId: target.featureId,
        kind: vertexIndex === 0 || vertexIndex === last ? 'endpoint' : 'vertex',
        vertexIndex,
        point: target.vertices[vertexIndex] as Point,
      };
    }
  }
}

function isBetter(a: SnapResult, b: SnapResult): boolean {
  if (a.distance !== b.distance) return a.distance < b.distance;
  return KIND_PRIORITY[a.kind] < KIND_PRIORITY[b.kind];
}
