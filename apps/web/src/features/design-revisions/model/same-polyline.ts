import { nearestOnCurve, type FilletPick, type Pt } from './geometry';

/** FILLET / CHAMFER of two curves: the kept first, the kept second, the arc or chamfer line. */
export type CornerCut = (first: FilletPick, second: FilletPick) => [Pt[], Pt[], Pt[]];

/**
 * FILLET / CHAMFER of two segments of ONE polyline (AutoCAD): the corner between them is rounded
 * (or cut) inside the polyline, which stays one object. The segments may be next to each other or
 * have one segment between them (AutoCAD drops it); repeated vertices and tiny pieces at the corner
 * are passed over. null when the picked segments are farther apart.
 */
export function cornerOnOne(
  raw: readonly Pt[],
  closed: boolean,
  pickA: Pt,
  pickB: Pt,
  cut: CornerCut,
): { points: Pt[]; closed: boolean; added: Pt[] } | null {
  const points = withoutRepeats(raw, closed);
  const n = points.length;
  const segments = closed ? n : n - 1;
  if (segments < 2) return null;
  const a = nearestOnCurve(points, closed, pickA).segment;
  const b = nearestOnCurve(points, closed, pickB).segment;
  if (a === b) return null;
  const forward = (from: number, to: number) =>
    closed ? (to - from + segments) % segments : to - from;
  // s1 comes first going along the polyline; gap = segments strictly between s1 and s2.
  const [s1, s2, firstPick, secondPick] =
    forward(a, b) > 0 && (forward(a, b) <= forward(b, a) || forward(b, a) <= 0)
      ? [a, b, pickA, pickB]
      : [b, a, pickB, pickA];
  const length = (i: number) => {
    const p = points[i % n] as Pt;
    const q = points[(i + 1) % n] as Pt;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  };
  const between: number[] = [];
  for (let k = 1; k < forward(s1, s2); k++) between.push((s1 + k) % segments);
  const small = Math.min(length(s1), length(s2)) * 0.05;
  const tiny = between.reduce((sum, i) => sum + length(i), 0) <= small;
  if (between.length > 1 && !tiny) return null;
  if (!closed) {
    const [p, q, added] = cut(
      { points: points.slice(0, s1 + 2), closed: false, pick: firstPick },
      { points: points.slice(s2), closed: false, pick: secondPick },
    );
    return { points: [...p, ...dropShared(p, q)], closed: false, added };
  }
  // Closed: from the end of s2 round to the end of s1, then s2 itself.
  const count = ((s1 - s2 + n) % n) + 1;
  const ring = Array.from({ length: count }, (_, k) => points[(s2 + 1 + k) % n] as Pt);
  const [p, q, added] = cut(
    { points: ring, closed: false, pick: firstPick },
    { points: [points[s2] as Pt, points[(s2 + 1) % n] as Pt], closed: false, pick: secondPick },
  );
  const joined = [...p, ...dropShared(p, q)];
  joined.pop(); // the last point is the first again: the polyline stays closed
  return { points: joined, closed: true, added };
}

/** The points without a vertex repeated (within a millionth of the polyline's size). */
function withoutRepeats(points: readonly Pt[], closed: boolean): Pt[] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const eps = size * 1e-6;
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (
    closed &&
    out.length > 1 &&
    first &&
    last &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) <= eps
  ) {
    out.pop();
  }
  return out;
}

const dropShared = (p: readonly Pt[], q: readonly Pt[]): Pt[] => {
  const end = p[p.length - 1];
  const head = q[0];
  return end && head && end[0] === head[0] && end[1] === head[1] ? q.slice(1) : [...q];
};
