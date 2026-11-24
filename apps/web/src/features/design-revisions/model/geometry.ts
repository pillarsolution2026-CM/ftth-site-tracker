/**
 * Drawing geometry of the AutoCAD-like screen (ADR-051), in drawing units. Pure: every command
 * computes new points here, and the screen saves them as corrections (`add_curve`, `set_curve`,
 * `erase_item`, `move_item`). Curves are polylines; circles and arcs become polylines too, since
 * the build reads points only.
 */

export type Pt = readonly [number, number];

/** Segments of a full circle drawn as a polyline. */
export const CIRCLE_SEGMENTS = 64;
const EPS = 1e-9;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => {
  const l = len(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
};
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

export const distance = (a: Pt, b: Pt) => len(sub(a, b));

/** The points of a curve, closed ones with the first point repeated at the end. */
export function ring(points: readonly Pt[], closed: boolean): Pt[] {
  const out = [...points];
  const first = out[0];
  if (closed && first && out.length > 1 && !same(first, out[out.length - 1] as Pt)) {
    out.push(first);
  }
  return out;
}

// ---------- shapes ----------

/** A circle as a closed polyline of `segments` points (first point at angle 0). */
export function circlePoints(center: Pt, radius: number, segments = CIRCLE_SEGMENTS): Pt[] {
  if (!(radius > 0)) throw new GeometryError('RADIUS');
  return Array.from({ length: segments }, (_, i) => {
    const a = (2 * Math.PI * i) / segments;
    return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)] as Pt;
  });
}

/** The circle through three points, or null when they are on one line. */
export function circleThrough(a: Pt, b: Pt, c: Pt): { center: Pt; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < EPS) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const center: Pt = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
  return { center, radius: distance(center, a) };
}

/** Points of an arc about `center` from angle `from` sweeping `sweep` radians (sign = direction). */
export function arcPoints(center: Pt, radius: number, from: number, sweep: number): Pt[] {
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * CIRCLE_SEGMENTS));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + (sweep * i) / steps;
    return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)] as Pt;
  });
}

/** AutoCAD's default ARC: start point, a second point on the arc, end point. */
export function arcThrough(start: Pt, second: Pt, end: Pt): Pt[] {
  const circle = circleThrough(start, second, end);
  if (!circle) throw new GeometryError('COLLINEAR');
  const { center, radius } = circle;
  const angle = (p: Pt) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const ccw = (from: number, to: number) => {
    const s = (to - from) % (2 * Math.PI);
    return s < 0 ? s + 2 * Math.PI : s;
  };
  const a0 = angle(start);
  const toSecond = ccw(a0, angle(second));
  const toEnd = ccw(a0, angle(end));
  // Counter-clockwise when the second point comes before the end that way, else clockwise.
  const sweep = toSecond < toEnd ? toEnd : toEnd - 2 * Math.PI;
  const out = arcPoints(center, radius, a0, sweep);
  out[0] = start;
  out[out.length - 1] = end;
  return out;
}

/** An axis-aligned rectangle from two opposite corners (closed, 4 points). */
export function rectanglePoints(a: Pt, b: Pt): Pt[] {
  if (Math.abs(a[0] - b[0]) < EPS || Math.abs(a[1] - b[1]) < EPS) {
    throw new GeometryError('FLAT');
  }
  return [a, [b[0], a[1]], b, [a[0], b[1]]];
}

// ---------- nearest place on a curve ----------

export interface Nearest {
  /** Segment index (from point i to i + 1 of `ring`). */
  segment: number;
  /** 0..1 along that segment. */
  t: number;
  point: Pt;
  distance: number;
  /** Distance along the curve from its first point. */
  along: number;
}

export function nearestOnCurve(points: readonly Pt[], closed: boolean, p: Pt): Nearest {
  const pts = ring(points, closed);
  let best: Nearest | null = null;
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const q = add(a, mul(ab, t));
    const d = distance(p, q);
    if (!best || d < best.distance) {
      best = { segment: i, t, point: q, distance: d, along: along + Math.sqrt(l2) * t };
    }
    along += Math.sqrt(l2);
  }
  if (!best) throw new GeometryError('EMPTY');
  return best;
}

// ---------- intersections ----------

/** Where segments ab and cd cross: the parameters along each (0..1), or null. */
function segmentHit(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const t = cross(sub(c, a), s) / den;
  const u = cross(sub(c, a), r) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.max(0, Math.min(1, t)), u };
}

/** Distances along `curve` where it crosses any of `edges` (sorted, without repeats). */
export function crossings(
  curve: readonly Pt[],
  closed: boolean,
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
): number[] {
  const pts = ring(curve, closed);
  const out: number[] = [];
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const l = distance(a, b);
    for (const edge of edges) {
      const e = ring(edge.points, edge.closed);
      for (let j = 0; j + 1 < e.length; j++) {
        const hit = segmentHit(a, b, e[j] as Pt, e[j + 1] as Pt);
        if (hit) out.push(along + hit.t * l);
      }
    }
    along += l;
  }
  out.sort((x, y) => x - y);
  return out.filter((v, i) => i === 0 || v - (out[i - 1] as number) > 1e-7);
}

/** The part of a curve between two distances along it (from ≤ to), as points. */
export function slice(points: readonly Pt[], closed: boolean, from: number, to: number): Pt[] {
  const pts = ring(points, closed);
  const out: Pt[] = [];
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const l = distance(a, b);
    const end = along + l;
    const at = (d: number): Pt => (l === 0 ? a : add(a, mul(sub(b, a), (d - along) / l)));
    if (end >= from - EPS && along <= to + EPS) {
      const start = Math.max(from, along);
      const stop = Math.min(to, end);
      const p = at(start);
      if (out.length === 0 || !same(out[out.length - 1] as Pt, p)) out.push(p);
      const q = at(stop);
      if (!same(out[out.length - 1] as Pt, q)) out.push(q);
    }
    along = end;
  }
  return out;
}

export function curveLength(points: readonly Pt[], closed: boolean): number {
  const pts = ring(points, closed);
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += distance(pts[i] as Pt, pts[i + 1] as Pt);
  return total;
}

// ---------- Trim ----------

/**
 * TRIM: the piece of the curve between the cutting edges where it was clicked goes; what is left
 * is returned as open pieces (none = the whole curve goes, as AutoCAD erases a curve that no edge
 * crosses only when asked; here it is refused with `NO_CROSSING`).
 */
export function trimCurve(
  points: readonly Pt[],
  closed: boolean,
  edges: readonly { points: readonly Pt[]; closed: boolean }[],
  pick: Pt,
): Pt[][] {
  const total = curveLength(points, closed);
  const cuts = crossings(points, closed, edges).filter((d) => d > 1e-7 && d < total - 1e-7);
  const at = nearestOnCurve(points, closed, pick).along;
  if (closed) {
    if (cuts.length < 2) throw new GeometryError('NO_CROSSING');
    const after = cuts.find((d) => d > at);
    const before = [...cuts].reverse().find((d) => d < at);
    // The removed piece is (before, after) going round; the kept piece runs from after to before.
    if (after !== undefined && before !== undefined) {
      return [[...slice(points, true, after, total), ...slice(points, true, 0, before).slice(1)]];
    }
    // The click is between the last and the first cut (across the closing point).
    const first = cuts[0] as number;
    const last = cuts[cuts.length - 1] as number;
    return [slice(points, true, first, last)];
  }
  if (cuts.length === 0) throw new GeometryError('NO_CROSSING');
  const before = [...cuts].reverse().find((d) => d < at);
  const after = cuts.find((d) => d > at);
  const pieces: Pt[][] = [];
  if (before !== undefined) pieces.push(slice(points, false, 0, before));
  if (after !== undefined) pieces.push(slice(points, false, after, total));
  return pieces.filter((p) => p.length >= 2);
}

// ---------- Offset ----------

/** The line through a and b, moved by `d` to its left. */
function shifted(a: Pt, b: Pt, d: number): [Pt, Pt] {
  const u = unit(sub(b, a));
  const n: Pt = [-u[1] * d, u[0] * d];
  return [add(a, n), add(b, n)];
}

/** Where the infinite lines a1-a2 and b1-b2 meet, or null when parallel. */
export function lineMeet(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < EPS * Math.max(1, len(r) * len(s))) return null;
  return add(a1, mul(r, cross(sub(b1, a1), s) / den));
}

/**
 * OFFSET: a parallel polyline at `dist` on the side of `side` (corners joined sharp, as AutoCAD's
 * default). Lines and polylines only.
 */
export function offsetCurve(points: readonly Pt[], closed: boolean, dist: number, side: Pt): Pt[] {
  if (!(dist > 0)) throw new GeometryError('DISTANCE');
  const pts = dedupe(points);
  if (pts.length < 2) throw new GeometryError('EMPTY');
  const near = nearestOnCurve(pts, closed, side);
  const loop = ring(pts, closed);
  const a = loop[near.segment] as Pt;
  const b = loop[near.segment + 1] as Pt;
  const d = cross(sub(b, a), sub(side, a)) >= 0 ? dist : -dist;
  const lines = [] as [Pt, Pt][];
  for (let i = 0; i + 1 < loop.length; i++)
    lines.push(shifted(loop[i] as Pt, loop[i + 1] as Pt, d));
  const out: Pt[] = [];
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const [p, q] = lines[i] as [Pt, Pt];
    if (i === 0 && !closed) {
      out.push(p);
      continue;
    }
    const prev = lines[(i - 1 + n) % n] as [Pt, Pt];
    out.push(lineMeet(prev[0], prev[1], p, q) ?? p);
  }
  if (!closed) out.push((lines[n - 1] as [Pt, Pt])[1]);
  return out;
}

function dedupe(points: readonly Pt[]): Pt[] {
  return points.filter((p, i) => i === 0 || !same(p, points[i - 1] as Pt));
}

// ---------- Fillet ----------

export interface FilletPick {
  points: readonly Pt[];
  closed: boolean;
  /** Where the curve was clicked: the side of the corner that is kept. */
  pick: Pt;
}

/**
 * FILLET of two different open curves at the picked segments. Radius 0: both are trimmed or
 * extended to their corner. Radius > 0: they stop where an arc of that radius touches them and
 * the arc is added to the first curve (both then meet at the end of the arc).
 */
export function fillet(first: FilletPick, second: FilletPick, radius: number): [Pt[], Pt[], Pt[]] {
  if (first.closed || second.closed) throw new GeometryError('CLOSED');
  if (radius < 0) throw new GeometryError('RADIUS');
  const s1 = pickedSegment(first);
  const s2 = pickedSegment(second);
  const corner = lineMeet(s1.a, s1.b, s2.a, s2.b);
  if (!corner) throw new GeometryError('PARALLEL');
  const k1 = keptSide(first, s1, corner);
  const k2 = keptSide(second, s2, corner);
  if (radius === 0) return [k1.withEnd(corner), k2.withEnd(corner), []];
  const u1 = unit(sub(k1.toward, corner));
  const u2 = unit(sub(k2.toward, corner));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-6 || Math.PI - theta < 1e-6) throw new GeometryError('PARALLEL');
  const tangent = radius / Math.tan(theta / 2);
  if (tangent > distance(corner, k1.toward) + EPS || tangent > distance(corner, k2.toward) + EPS) {
    throw new GeometryError('RADIUS_TOO_LARGE');
  }
  const t1 = add(corner, mul(u1, tangent));
  const t2 = add(corner, mul(u2, tangent));
  const center = add(corner, mul(unit(add(u1, u2)), radius / Math.sin(theta / 2)));
  const from = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
  const to = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
  let sweep = to - from;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const arc = arcPoints(center, radius, from, sweep);
  arc[0] = t1;
  arc[arc.length - 1] = t2;
  // The third: the arc alone (FILLET with Trim mode «No trim» draws only it).
  return [k1.withEnd(...arc), k2.withEnd(t2), arc];
}

function pickedSegment(c: FilletPick): { i: number; a: Pt; b: Pt; t: number } {
  const pts = dedupe(c.points);
  const near = nearestOnCurve(pts, false, c.pick);
  return { i: near.segment, a: pts[near.segment] as Pt, b: pts[near.segment + 1] as Pt, t: near.t };
}

/**
 * The side of the picked segment where the click is, as seen from the corner: the curve keeps
 * that side and gets the given points at its corner end.
 */
function keptSide(
  c: FilletPick,
  s: { i: number; a: Pt; b: Pt; t: number },
  corner: Pt,
): { toward: Pt; withEnd: (...end: Pt[]) => Pt[] } {
  const pts = dedupe(c.points);
  const ab = sub(s.b, s.a);
  const tc = dot(sub(corner, s.a), ab) / dot(ab, ab);
  if (s.t <= tc) {
    // Keep the start side: points up to the segment's start, then the corner end.
    const keep = pts.slice(0, s.i + 1);
    const toward = same(keep[keep.length - 1] as Pt, corner) ? (pts[s.i - 1] ?? s.a) : s.a;
    return { toward, withEnd: (...end) => dedupe([...keep, ...end]) };
  }
  const keep = pts.slice(s.i + 1);
  const toward = same(keep[0] as Pt, corner) ? (pts[s.i + 2] ?? s.b) : s.b;
  return { toward, withEnd: (...end) => dedupe([...[...end].reverse(), ...keep]) };
}

// ---------- Stretch ----------

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const inBox = (box: Box, p: Pt) =>
  p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;

/** STRETCH: the vertices inside the crossing window move by (dx, dy); null when none is inside. */
export function stretchCurve(points: readonly Pt[], box: Box, dx: number, dy: number): Pt[] | null {
  let moved = false;
  const out = points.map((p): Pt => {
    if (!inBox(box, p)) return p;
    moved = true;
    return [p[0] + dx, p[1] + dy];
  });
  return moved ? out : null;
}

// ---------- errors ----------

export type GeometryErrorCode =
  | 'RADIUS'
  | 'RADIUS_TOO_LARGE'
  | 'COLLINEAR'
  | 'FLAT'
  | 'EMPTY'
  | 'NO_CROSSING'
  | 'DISTANCE'
  | 'PARALLEL'
  | 'CLOSED'
  | 'SHAPE'
  | 'SPLIT_CLOSED';

/** A command cannot be done with these points; `code` names the reason for the command line. */
export class GeometryError extends Error {
  constructor(readonly code: GeometryErrorCode) {
    super(code);
    this.name = 'GeometryError';
  }
}

// ---------- dimensions ----------

export interface LinearDimension {
  /** Horizontal (measures X) or vertical (measures Y), chosen by where the line is put. */
  direction: 'horizontal' | 'vertical';
  /** The dimension line, from the first to the second extension line. */
  line: [Pt, Pt];
  /** Extension lines: from each measured point to the dimension line. */
  extensions: [[Pt, Pt], [Pt, Pt]];
  value: number;
  /** Middle of the dimension line (the text goes there). */
  middle: Pt;
}

/**
 * DIMLINEAR as AutoCAD places it: a dimension line put above or below the two points measures X;
 * put left or right of them, it measures Y; otherwise the longer side.
 */
export function linearDimension(a: Pt, b: Pt, at: Pt): LinearDimension {
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  const besideX = at[0] < minX || at[0] > maxX;
  const besideY = at[1] < minY || at[1] > maxY;
  const horizontal =
    besideY && !besideX ? true : besideX && !besideY ? false : maxX - minX >= maxY - minY;
  if (horizontal) {
    const p: Pt = [a[0], at[1]];
    const q: Pt = [b[0], at[1]];
    return {
      direction: 'horizontal',
      line: [p, q],
      extensions: [
        [a, p],
        [b, q],
      ],
      value: maxX - minX,
      middle: [(a[0] + b[0]) / 2, at[1]],
    };
  }
  const p: Pt = [at[0], a[1]];
  const q: Pt = [at[0], b[1]];
  return {
    direction: 'vertical',
    line: [p, q],
    extensions: [
      [a, p],
      [b, q],
    ],
    value: maxY - minY,
    middle: [at[0], (a[1] + b[1]) / 2],
  };
}
