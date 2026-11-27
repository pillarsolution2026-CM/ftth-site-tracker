import { crossings, distance, slice, type Pt } from './geometry';

/** A true arc (centre, radius, angles in degrees counter-clockwise; a circle is 0 → 360). */
export interface ArcShape {
  x: number;
  y: number;
  r: number;
  start: number;
  end: number;
}

/**
 * AutoCAD's OFFSET of an arc or a circle: the concentric one `dist` away on the side clicked
 * (outside when the point is farther from the centre than the arc). null: inward past the centre.
 */
export function arcOffset(arc: ArcShape, dist: number, side: Pt): ArcShape | null {
  const out = distance(side, [arc.x, arc.y]) > arc.r;
  const r = out ? arc.r + dist : arc.r - dist;
  return r > 1e-9 ? { ...arc, r } : null;
}

/** OFFSET Through on an arc or a circle: the distance from it to the point. */
export const throughArcDistance = (arc: ArcShape, at: Pt) =>
  Math.abs(distance(at, [arc.x, arc.y]) - arc.r);

/**
 * TRIM's fence (quick mode, a drag): the points where the fence a → b crosses the object, in the
 * order along the object; each one is a pick of the piece to remove.
 */
export function fencePicks(points: readonly Pt[], closed: boolean, a: Pt, b: Pt): Pt[] {
  const fence = [{ points: [a, b], closed: false }];
  return crossings(points, closed, fence).map((d) => slice(points, closed, d, d)[0] as Pt);
}
