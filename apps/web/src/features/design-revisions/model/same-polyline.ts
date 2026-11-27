import { nearestOnCurve, type FilletPick, type Pt } from './geometry';

/** FILLET / CHAMFER of two curves: the kept first, the kept second, the arc or chamfer line. */
export type CornerCut = (first: FilletPick, second: FilletPick) => [Pt[], Pt[], Pt[]];

/**
 * FILLET / CHAMFER of two adjacent segments of ONE polyline (AutoCAD): the corner between them is
 * rounded (or cut) inside the polyline, which stays one object. null when the picked segments are
 * not next to each other.
 */
export function cornerOnOne(
  points: readonly Pt[],
  closed: boolean,
  pickA: Pt,
  pickB: Pt,
  cut: CornerCut,
): { points: Pt[]; closed: boolean; added: Pt[] } | null {
  const n = points.length;
  const segments = closed ? n : n - 1;
  const a = nearestOnCurve(points, closed, pickA).segment;
  const b = nearestOnCurve(points, closed, pickB).segment;
  // The segment that ends at the shared vertex comes first.
  let vertex: number;
  let firstPick: Pt;
  let secondPick: Pt;
  if ((a + 1) % segments === b && (closed || a + 1 === b) && a !== b) {
    vertex = (a + 1) % n;
    [firstPick, secondPick] = [pickA, pickB];
  } else if ((b + 1) % segments === a && (closed || b + 1 === a) && a !== b) {
    vertex = (b + 1) % n;
    [firstPick, secondPick] = [pickB, pickA];
  } else return null;
  if (!closed) {
    const [p, q, added] = cut(
      { points: points.slice(0, vertex + 1), closed: false, pick: firstPick },
      { points: points.slice(vertex), closed: false, pick: secondPick },
    );
    return { points: [...p, ...dropShared(p, q)], closed: false, added };
  }
  // Closed: walk round from the vertex after the corner back to it, then one more step.
  const ring = Array.from({ length: n }, (_, k) => points[(vertex + 1 + k) % n] as Pt);
  const [p, q, added] = cut(
    { points: ring, closed: false, pick: firstPick },
    {
      points: [points[vertex] as Pt, points[(vertex + 1) % n] as Pt],
      closed: false,
      pick: secondPick,
    },
  );
  const joined = [...p, ...dropShared(p, q)];
  joined.pop(); // the last point is the first again: the polyline stays closed
  return { points: joined, closed: true, added };
}

const dropShared = (p: readonly Pt[], q: readonly Pt[]): Pt[] => {
  const end = p[p.length - 1];
  const head = q[0];
  return end && head && end[0] === head[0] && end[1] === head[1] ? q.slice(1) : [...q];
};
