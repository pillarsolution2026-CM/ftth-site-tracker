import {
  arcPoints,
  crossings,
  curveLength,
  distance,
  GeometryError,
  lineMeet,
  nearestOnCurve,
  ring,
  type Pt,
} from './geometry';

/**
 * Geometry of the AutoCAD command options (ADR-051, owner 2026-11-19: «the commands with their
 * command-line details»): PLINE arcs, FILLET Polyline, RECTANG Chamfer / Fillet / Dimensions /
 * Rotation / Area, CIRCLE Ttr, ARC Center / End-Radius / Angle, TRIM's shift-select Extend, OFFSET
 * Through. Pure, drawing units, angles in degrees counter-clockwise as CAD.
 */

const EPS = 1e-9;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const unit = (a: Pt): Pt => {
  const l = Math.hypot(a[0], a[1]);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
};
const rad = (deg: number) => (deg * Math.PI) / 180;
const angleOf = (c: Pt, p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
/** The arc sweep from angle `a` to `b` going counter-clockwise, in (0, 2π]. */
const ccwSweep = (a: number, b: number) => {
  let s = (b - a) % (2 * Math.PI);
  if (s <= EPS) s += 2 * Math.PI;
  return s;
};

/**
 * PLINE Arc: an arc from `start` to `end` that leaves `start` along `direction` (tangent to the
 * segment before it, as AutoCAD). The first point is not repeated in the result.
 */
export function tangentArc(start: Pt, direction: Pt, end: Pt): Pt[] {
  const d = unit(direction);
  const chord = sub(end, start);
  const n: Pt = [-d[1], d[0]];
  const along = dot(n, chord);
  if (Math.abs(along) < EPS) return [end];
  const r = dot(chord, chord) / (2 * along);
  const center = add(start, mul(n, r));
  const from = angleOf(center, start);
  const to = angleOf(center, end);
  const sweep = r > 0 ? ccwSweep(from, to) : -ccwSweep(to, from);
  const pts = arcPoints(center, Math.abs(r), from, sweep);
  pts[pts.length - 1] = end;
  return pts.slice(1);
}

/**
 * The direction an arc arrives at its end point, exactly: the start direction mirrored across the
 * chord (a circle's two tangents to a chord are symmetric). For PLINE Arc then Line / Length.
 */
export function arcEndDirection(start: Pt, direction: Pt, end: Pt): Pt {
  const d = unit(direction);
  const c = unit(sub(end, start));
  const k = 2 * dot(d, c);
  return unit([c[0] * k - d[0], c[1] * k - d[1]]);
}

/** The direction a 3-point arc arrives at its end (perpendicular to the radius there). */
export function arcThroughEndDirection(start: Pt, second: Pt, end: Pt): Pt {
  const r1 = sub(second, start);
  const r2 = sub(end, second);
  // Turning left (counter-clockwise) or right decides which way the tangent points.
  const left = cross(r1, r2) > 0;
  const mid1 = mul(add(start, second), 0.5);
  const mid2 = mul(add(second, end), 0.5);
  const center = lineMeet(mid1, add(mid1, [-r1[1], r1[0]]), mid2, add(mid2, [-r2[1], r2[0]]));
  if (!center) return unit(sub(end, second));
  const radial = unit(sub(end, center));
  return left ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
}

/** The direction a polyline ends in (for the next tangent arc); +X when it has one point. */
export function endDirection(points: readonly Pt[]): Pt {
  const n = points.length;
  if (n < 2) return [1, 0];
  return unit(sub(points[n - 1] as Pt, points[n - 2] as Pt));
}

/**
 * FILLET Polyline: every corner of the polyline gets an arc of `radius`. Corners whose segments
 * are too short for the radius are left as they are (AutoCAD says so); returns how many were
 * filleted.
 */
export function filletPolyline(
  points: readonly Pt[],
  closed: boolean,
  radius: number,
): { points: Pt[]; filleted: number; tooShort: number } {
  if (!(radius > 0)) throw new GeometryError('RADIUS');
  const pts = points.filter((p, i) => i === 0 || distance(p, points[i - 1] as Pt) > EPS);
  const n = pts.length;
  const out: Pt[] = [];
  let filleted = 0;
  let tooShort = 0;
  for (let i = 0; i < n; i++) {
    const v = pts[i] as Pt;
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    if (!hasPrev || !hasNext) {
      out.push(v);
      continue;
    }
    const a = pts[(i - 1 + n) % n] as Pt;
    const b = pts[(i + 1) % n] as Pt;
    const u1 = unit(sub(a, v));
    const u2 = unit(sub(b, v));
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
    if (theta < 1e-6 || Math.PI - theta < 1e-6) {
      out.push(v);
      continue;
    }
    const tangent = radius / Math.tan(theta / 2);
    if (tangent > distance(a, v) / 2 + EPS || tangent > distance(b, v) / 2 + EPS) {
      tooShort++;
      out.push(v);
      continue;
    }
    const t1 = add(v, mul(u1, tangent));
    const t2 = add(v, mul(u2, tangent));
    const center = add(v, mul(unit(add(u1, u2)), radius / Math.sin(theta / 2)));
    const from = angleOf(center, t1);
    const to = angleOf(center, t2);
    let sweep = to - from;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    const arc = arcPoints(center, radius, from, sweep);
    arc[0] = t1;
    arc[arc.length - 1] = t2;
    out.push(...arc);
    filleted++;
  }
  return { points: out, filleted, tooShort };
}

/** RECTANG Chamfer: each corner of a closed polygon cut by `d1` along the side before it and `d2` after. */
export function chamferPolygon(points: readonly Pt[], d1: number, d2: number): Pt[] {
  if (!(d1 > 0) && !(d2 > 0)) return [...points];
  const n = points.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const v = points[i] as Pt;
    const a = points[(i - 1 + n) % n] as Pt;
    const b = points[(i + 1) % n] as Pt;
    if (d1 > distance(a, v) / 2 + EPS || d2 > distance(b, v) / 2 + EPS) {
      throw new GeometryError('RADIUS_TOO_LARGE');
    }
    out.push(add(v, mul(unit(sub(a, v)), d1)), add(v, mul(unit(sub(b, v)), d2)));
  }
  return out;
}

/**
 * RECTANG with Dimensions / Rotation: from the first corner, `length` along the rotation angle and
 * `width` across it; the other corner point only chooses the side (quadrant), as AutoCAD.
 */
export function rectangleFrom(
  corner: Pt,
  length: number,
  width: number,
  rotation: number,
  towards: Pt | null,
): Pt[] {
  if (!(length > 0) || !(width > 0)) throw new GeometryError('FLAT');
  const u: Pt = [Math.cos(rad(rotation)), Math.sin(rad(rotation))];
  const v: Pt = [-u[1], u[0]];
  const rel = towards ? sub(towards, corner) : add(u, v);
  const su = dot(rel, u) < 0 ? -1 : 1;
  const sv = dot(rel, v) < 0 ? -1 : 1;
  const a = mul(u, length * su);
  const b = mul(v, width * sv);
  return [corner, add(corner, a), add(add(corner, a), b), add(corner, b)];
}

/** RECTANG rotated by `rotation` degrees with the other corner given: its sides follow the angle. */
export function rotatedRectangle(corner: Pt, other: Pt, rotation: number): Pt[] {
  const u: Pt = [Math.cos(rad(rotation)), Math.sin(rad(rotation))];
  const v: Pt = [-u[1], u[0]];
  const rel = sub(other, corner);
  const length = dot(rel, u);
  const width = dot(rel, v);
  if (Math.abs(length) < EPS || Math.abs(width) < EPS) throw new GeometryError('FLAT');
  return [corner, add(corner, mul(u, length)), other, add(corner, mul(v, width))];
}

/**
 * CIRCLE Ttr: the circle of `radius` tangent to the two lines (segments a and b, infinite), on the
 * side of each nearest the points picked on them (AutoCAD takes the solution nearest the picks).
 */
export function circleTangentTangent(
  a: readonly [Pt, Pt],
  pickA: Pt,
  b: readonly [Pt, Pt],
  pickB: Pt,
  radius: number,
): Pt {
  if (!(radius > 0)) throw new GeometryError('RADIUS');
  const shift = (s: readonly [Pt, Pt], k: number): [Pt, Pt] => {
    const d = unit(sub(s[1], s[0]));
    const n = mul([-d[1], d[0]], k);
    return [add(s[0], n), add(s[1], n)];
  };
  let best: Pt | null = null;
  let bestScore = Infinity;
  for (const ka of [radius, -radius]) {
    for (const kb of [radius, -radius]) {
      const la = shift(a, ka);
      const lb = shift(b, kb);
      const c = lineMeet(la[0], la[1], lb[0], lb[1]);
      if (!c) continue;
      const score = distance(c, pickA) + distance(c, pickB);
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
    }
  }
  if (!best) throw new GeometryError('PARALLEL');
  return best;
}

/**
 * ARC by centre: from `start` counter-clockwise about `center` to the direction of `end`, or by an
 * included angle (degrees; negative = clockwise).
 */
export function arcCenter(center: Pt, start: Pt, end: Pt | null, angle: number | null): Pt[] {
  const r = distance(center, start);
  if (!(r > 0)) throw new GeometryError('RADIUS');
  const from = angleOf(center, start);
  const sweep = angle !== null ? rad(angle) : ccwSweep(from, angleOf(center, end ?? start));
  if (Math.abs(sweep) < EPS) throw new GeometryError('EMPTY');
  const pts = arcPoints(center, r, from, sweep);
  pts[0] = start;
  return pts;
}

/**
 * ARC Start, End, Radius: counter-clockwise from start to end (a negative radius takes the major
 * arc, as AutoCAD). Start, End, Angle: the included angle decides the radius.
 */
export function arcStartEnd(start: Pt, end: Pt, by: { radius: number } | { angle: number }): Pt[] {
  const chord = distance(start, end);
  if (!(chord > 0)) throw new GeometryError('EMPTY');
  let r: number;
  let major: boolean;
  if ('radius' in by) {
    r = Math.abs(by.radius);
    major = by.radius < 0;
    if (r < chord / 2 - EPS) throw new GeometryError('RADIUS');
  } else {
    const a = rad(by.angle);
    if (Math.abs(Math.sin(a / 2)) < EPS) throw new GeometryError('EMPTY');
    r = chord / (2 * Math.abs(Math.sin(a / 2)));
    major = Math.abs(a) > Math.PI;
  }
  const mid = mul(add(start, end), 0.5);
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const d = unit(sub(end, start));
  const left: Pt = [-d[1], d[0]];
  // Counter-clockwise from start to end: the minor arc's centre is on the left of the chord.
  const center = add(mid, mul(left, major ? -h : h));
  const from = angleOf(center, start);
  const pts = arcPoints(center, r, from, ccwSweep(from, angleOf(center, end)));
  pts[0] = start;
  pts[pts.length - 1] = end;
  return pts;
}

/**
 * TRIM shift-select (Extend): the open end of the curve nearest the pick goes on along its last
 * segment to the nearest edge it meets. Returns the new points.
 */
export function extendCurve(
  points: readonly Pt[],
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
  pick: Pt,
): Pt[] {
  if (points.length < 2) throw new GeometryError('EMPTY');
  const atEnd = distance(pick, points[points.length - 1] as Pt) < distance(pick, points[0] as Pt);
  const pts = atEnd ? [...points] : [...points].reverse();
  const tip = pts[pts.length - 1] as Pt;
  const dir = unit(sub(tip, pts[pts.length - 2] as Pt));
  let best: Pt | null = null;
  let bestT = Infinity;
  for (const edge of edges) {
    const e = ring(edge.points, edge.closed);
    for (let j = 0; j + 1 < e.length; j++) {
      const c = e[j] as Pt;
      const d = e[j + 1] as Pt;
      const s = sub(d, c);
      const den = cross(dir, s);
      if (Math.abs(den) < EPS) continue;
      const t = cross(sub(c, tip), s) / den;
      const u = cross(sub(c, tip), dir) / den;
      if (t > 1e-7 && u >= -EPS && u <= 1 + EPS && t < bestT) {
        bestT = t;
        best = add(tip, mul(dir, t));
      }
    }
  }
  if (!best) throw new GeometryError('NO_CROSSING');
  pts[pts.length - 1] = best;
  return atEnd ? pts : pts.reverse();
}

/** OFFSET Through: the distance from the curve to the point (the side is the point's). */
export const throughDistance = (points: readonly Pt[], closed: boolean, p: Pt) =>
  nearestOnCurve(points, closed, p).distance;

/** TRIM with chosen cutting edges only (cuTting edges): which crossings count. */
export const crossingCount = (
  points: readonly Pt[],
  closed: boolean,
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
) =>
  crossings(points, closed, edges).filter((d) => d > 1e-7 && d < curveLength(points, closed) - 1e-7)
    .length;
