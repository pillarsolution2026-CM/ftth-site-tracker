import { insertVertex, moveVertex, removeVertex } from './grips.js';
import type { Point, Polyline } from './point.js';
import { translatePolyline } from './polyline.js';

/**
 * One user edit on a route, as data. The operations of a session are what the
 * device sends (with its `client_op_id`) to become immutable As-Built events.
 */
export type EditOperation =
  | { readonly type: 'moveVertex'; readonly vertexIndex: number; readonly to: Point }
  | { readonly type: 'insertVertex'; readonly segmentIndex: number; readonly at?: Point }
  | { readonly type: 'removeVertex'; readonly vertexIndex: number }
  | { readonly type: 'translate'; readonly dx: number; readonly dy: number };

/** Applies one operation; pure and deterministic, so replaying the same operations gives the same route. */
export function applyEdit(line: Polyline, op: EditOperation): Polyline {
  switch (op.type) {
    case 'moveVertex':
      return moveVertex(line, op.vertexIndex, op.to);
    case 'insertVertex':
      return insertVertex(line, op.segmentIndex, op.at);
    case 'removeVertex':
      return removeVertex(line, op.vertexIndex);
    case 'translate':
      return translatePolyline(line, op.dx, op.dy);
  }
}
