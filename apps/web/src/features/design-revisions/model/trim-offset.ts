import {
  crossings,
  distance,
  GeometryError,
  nearestOnCurve,
  slice,
  trimCurve,
  type Pt,
} from './geometry';

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

/**
 * TRIM at several picks on one object (a fence crossing it more than once): each pick removes the
 * piece it lies on, from what is left after the picks before it. The open pieces left; [] = the
 * object is gone. A pick where nothing can be cut is passed over.
 */
export function trimAtPicks(
  points: readonly Pt[],
  closed: boolean,
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
  picks: readonly Pt[],
): { pieces: Pt[][]; cut: boolean } {
  let pieces: { points: Pt[]; closed: boolean }[] = [{ points: [...points], closed }];
  let cut = false;
  for (const pick of picks) {
    let best = -1;
    let gap = Infinity;
    pieces.forEach((piece, i) => {
      const d = nearestOnCurve(piece.points, piece.closed, pick).distance;
      if (d < gap) [best, gap] = [i, d];
    });
    const piece = pieces[best];
    if (!piece) break;
    try {
      const left = trimCurve(piece.points, piece.closed, edges, pick).map((p) => ({
        points: [...p],
        closed: false,
      }));
      pieces = [...pieces.slice(0, best), ...left, ...pieces.slice(best + 1)];
      cut = true;
    } catch (caught) {
      if (!(caught instanceof GeometryError)) throw caught;
    }
  }
  return { pieces: pieces.map((p) => p.points), cut };
}

const norm = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * EXTEND of an arc (AutoCAD): the end nearer the pick runs on along its circle to the first
 * boundary edge it meets. Throws NO_CROSSING when no edge is met.
 */
export function extendArc(
  arc: ArcShape,
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
  pick: Pt,
): ArcShape {
  const sweep = norm(arc.end - arc.start) || 360;
  if (sweep >= 360 - 1e-9) throw new GeometryError('CLOSED');
  const at = (deg: number): Pt => [
    arc.x + arc.r * Math.cos((deg * Math.PI) / 180),
    arc.y + arc.r * Math.sin((deg * Math.PI) / 180),
  ];
  const atEnd = distance(pick, at(arc.end)) < distance(pick, at(arc.start));
  let best = Infinity;
  for (const edge of edges) {
    const pts = edge.closed ? [...edge.points, edge.points[0] as Pt] : edge.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const deg of circleHits(arc, pts[i] as Pt, pts[i + 1] as Pt)) {
        const turn = atEnd ? norm(deg - arc.end) : norm(arc.start - deg);
        if (turn > 1e-7 && turn < 360 - sweep && turn < best) best = turn;
      }
    }
  }
  if (best === Infinity) throw new GeometryError('NO_CROSSING');
  const start = atEnd ? norm(arc.start) : norm(arc.start - best);
  return { ...arc, start, end: start + sweep + best };
}

/** Angles (degrees) where the segment a → b meets the arc's circle. */
function circleHits(arc: ArcShape, a: Pt, b: Pt): number[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - arc.x;
  const fy = a[1] - arc.y;
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - arc.r * arc.r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)]
    .filter((t) => t >= -1e-9 && t <= 1 + 1e-9)
    .map((t) => norm((Math.atan2(fy + t * dy, fx + t * dx) * 180) / Math.PI));
}
