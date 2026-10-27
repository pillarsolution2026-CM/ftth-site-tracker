import { assertFinitePoint, GeometryError, midpoint, type Point, type Polyline } from './point.js';
import { assertPolyline, MIN_POLYLINE_VERTICES } from './polyline.js';

/**
 * Grips shown on a selected route: one per vertex (drag to move, long-press to
 * delete) and one at the middle of each segment (drag to insert a new vertex).
 */
export type Grip =
  | { readonly kind: 'vertex'; readonly vertexIndex: number; readonly at: Point }
  | { readonly kind: 'midpoint'; readonly segmentIndex: number; readonly at: Point };

export function gripsOf(line: Polyline): Grip[] {
  assertPolyline(line);
  const grips: Grip[] = line.map((at, vertexIndex) => ({ kind: 'vertex', vertexIndex, at }));
  for (let segmentIndex = 0; segmentIndex < line.length - 1; segmentIndex++) {
    grips.push({
      kind: 'midpoint',
      segmentIndex,
      at: midpoint(line[segmentIndex] as Point, line[segmentIndex + 1] as Point),
    });
  }
  return grips;
}

export function moveVertex(line: Polyline, vertexIndex: number, to: Point): Polyline {
  assertPolyline(line);
  assertVertexIndex(line, vertexIndex);
  assertFinitePoint(to);
  return line.map((p, i) => (i === vertexIndex ? to : p));
}

/** Inserts a vertex inside segment `segmentIndex` (between vertices i and i+1); defaults to its midpoint. */
export function insertVertex(line: Polyline, segmentIndex: number, at?: Point): Polyline {
  assertPolyline(line);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= line.length - 1) {
    throw new GeometryError(
      'VERTEX_OUT_OF_RANGE',
      `Segment ${segmentIndex} is outside 0..${line.length - 2}`,
    );
  }
  const inserted = at ?? midpoint(line[segmentIndex] as Point, line[segmentIndex + 1] as Point);
  assertFinitePoint(inserted);
  return [...line.slice(0, segmentIndex + 1), inserted, ...line.slice(segmentIndex + 1)];
}

export function removeVertex(line: Polyline, vertexIndex: number): Polyline {
  assertPolyline(line);
  assertVertexIndex(line, vertexIndex);
  if (line.length <= MIN_POLYLINE_VERTICES) {
    throw new GeometryError('TOO_FEW_VERTICES', 'Cannot remove a vertex from a two-vertex route');
  }
  return line.filter((_, i) => i !== vertexIndex);
}

function assertVertexIndex(line: Polyline, vertexIndex: number): void {
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= line.length) {
    throw new GeometryError(
      'VERTEX_OUT_OF_RANGE',
      `Vertex ${vertexIndex} is outside 0..${line.length - 1}`,
    );
  }
}
