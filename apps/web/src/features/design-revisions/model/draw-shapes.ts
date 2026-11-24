import { curveLength, distance, GeometryError, ring, slice, type Pt } from './geometry';

/**
 * Geometry of the drawing screen's Draw and Modify commands added for the owner (2026-11-24):
 * BREAK, LENGTHEN, REVERSE, ARRAYRECT, SPLINE, ELLIPSE, POLYGON, HELIX, DIVIDE, MEASURE and the
 * closed boundaries of HATCH / BOUNDARY / REGION. Drawing units; curves are point lists as the
 * rest of the workspace (an ellipse or spline is kept as a fine polyline, as `add_curve` stores).
 */

const EPS = 1e-9;
/** Segments of a full ellipse, and of each spline span. */
export const ELLIPSE_SEGMENTS = 72;
export const SPLINE_STEPS = 16;
export const HELIX_STEPS_PER_TURN = 48;

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const usable = (piece: Pt[]) => piece.length >= 2 && curveLength(piece, false) > EPS;

/** The point at a distance along the curve. */
export function pointAlong(points: readonly Pt[], closed: boolean, d: number): Pt {
  const part = slice(points, closed, 0, d);
  const last = part[part.length - 1];
  if (!last) throw new GeometryError('EMPTY');
  return last;
}

/**
 * BREAK: the part between two distances along the curve goes. An open curve leaves up to two
 * pieces; a closed one leaves one open piece, from the second point round to the first (AutoCAD
 * goes counter-clockwise; here along the curve's own direction).
 */
export function breakCurve(points: readonly Pt[], closed: boolean, d1: number, d2: number): Pt[][] {
  const total = curveLength(points, closed);
  const from = Math.max(0, Math.min(d1, d2));
  const to = Math.min(total, Math.max(d1, d2));
  if (!closed) {
    return [slice(points, false, 0, from), slice(points, false, to, total)].filter(usable);
  }
  if (to - from < EPS) throw new GeometryError('SHAPE');
  const after = slice(points, true, to, total);
  const before = slice(points, true, 0, from);
  const joined = [...after];
  for (const p of before) if (!same(joined[joined.length - 1] as Pt, p)) joined.push(p);
  return [joined].filter(usable);
}

/** BREAKATPOINT: an open curve in two at a distance along it; a closed one cannot be split so. */
export function splitAt(points: readonly Pt[], closed: boolean, d: number): [Pt[], Pt[]] {
  if (closed) throw new GeometryError('SPLIT_CLOSED');
  const total = curveLength(points, false);
  if (d <= EPS || d >= total - EPS) throw new GeometryError('SHAPE');
  return [slice(points, false, 0, d), slice(points, false, d, total)];
}

/**
 * LENGTHEN: the end nearer `atStart` (true: the first point) gets `delta` longer (straight on in
 * its direction) or shorter (cut back along the curve).
 */
export function lengthenEnd(points: readonly Pt[], atStart: boolean, delta: number): Pt[] {
  const pts = atStart ? [...points].reverse() : [...points];
  const total = curveLength(pts, false);
  if (total + delta <= EPS) throw new GeometryError('SHAPE');
  let out: Pt[];
  if (delta >= 0) {
    const last = pts[pts.length - 1] as Pt;
    let i = pts.length - 2;
    while (i >= 0 && same(pts[i] as Pt, last)) i -= 1;
    const before = pts[i];
    if (!before) throw new GeometryError('SHAPE');
    const l = distance(before, last);
    const dir: Pt = [(last[0] - before[0]) / l, (last[1] - before[1]) / l];
    out = [...pts.slice(0, -1), [last[0] + dir[0] * delta, last[1] + dir[1] * delta]];
  } else {
    out = slice(pts, false, 0, total + delta);
  }
  return atStart ? out.reverse() : out;
}

/** ARRAYRECT: the moves of every copy (the first cell, 0,0, is the source). */
export function arrayOffsets(columns: number, rows: number, dx: number, dy: number): Pt[] {
  const out: Pt[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (row === 0 && col === 0) continue;
      out.push([col * dx, row * dy]);
    }
  }
  return out;
}

// ---------- shapes ----------

/**
 * ELLIPSE: centre, the end of the major (first) axis as a vector from the centre, and the other
 * axis as a ratio of it; `from`..`to` are parameter angles in degrees (an elliptical arc).
 */
export function ellipsePoints(
  center: Pt,
  axis: Pt,
  ratio: number,
  from = 0,
  to = 360,
  segments = ELLIPSE_SEGMENTS,
): Pt[] {
  const a = Math.hypot(axis[0], axis[1]);
  if (a <= EPS || !(ratio > 0)) throw new GeometryError('SHAPE');
  const ux: Pt = [axis[0] / a, axis[1] / a];
  const vy: Pt = [-ux[1], ux[0]];
  const b = a * ratio;
  let sweep = to - from;
  while (sweep <= 0) sweep += 360;
  const full = sweep >= 360 - EPS;
  const n = Math.max(8, Math.ceil((segments * Math.min(sweep, 360)) / 360));
  const out: Pt[] = [];
  for (let i = 0; i <= (full ? n - 1 : n); i++) {
    const t = ((from + (Math.min(sweep, 360) * i) / n) * Math.PI) / 180;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    out.push([center[0] + ux[0] * x + vy[0] * y, center[1] + ux[1] * x + vy[1] * y]);
  }
  return out;
}

/** POLYGON about a centre: inscribed (vertices on the circle) or circumscribed (edges touch it). */
export function polygonPoints(
  center: Pt,
  sides: number,
  radius: number,
  inscribed: boolean,
  /** Direction of the first vertex (inscribed) or edge middle (circumscribed), degrees. */
  angle = 90,
): Pt[] {
  if (!(Number.isInteger(sides) && sides >= 3 && sides <= 1024) || !(radius > 0)) {
    throw new GeometryError('SHAPE');
  }
  const step = (2 * Math.PI) / sides;
  const r = inscribed ? radius : radius / Math.cos(step / 2);
  const start = (angle * Math.PI) / 180 + (inscribed ? 0 : step / 2);
  return Array.from({ length: sides }, (_, i) => [
    center[0] + r * Math.cos(start + i * step),
    center[1] + r * Math.sin(start + i * step),
  ]);
}

/** POLYGON Edge: the polygon with its first edge from `a` to `b`, on the left of it. */
export function polygonOnEdge(a: Pt, b: Pt, sides: number): Pt[] {
  const side = distance(a, b);
  if (side <= EPS || !(Number.isInteger(sides) && sides >= 3 && sides <= 1024)) {
    throw new GeometryError('SHAPE');
  }
  const out: Pt[] = [a, b];
  const turn = (2 * Math.PI) / sides;
  let dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
  let at = b;
  for (let i = 2; i < sides; i++) {
    dir += turn;
    at = [at[0] + side * Math.cos(dir), at[1] + side * Math.sin(dir)];
    out.push(at);
  }
  return out;
}

/** HELIX seen from above: a spiral from the base radius to the top radius in `turns` turns. */
export function helixPoints(
  center: Pt,
  base: number,
  top: number,
  turns: number,
  /** Where it starts, degrees; counter-clockwise unless `clockwise`. */
  start = 0,
  clockwise = false,
): Pt[] {
  if (!(base > 0) || !(top >= 0) || !(turns > 0 && turns <= 500)) {
    throw new GeometryError('SHAPE');
  }
  const n = Math.max(8, Math.ceil(turns * HELIX_STEPS_PER_TURN));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    const t = (start * Math.PI) / 180 + (clockwise ? -1 : 1) * k * turns * 2 * Math.PI;
    const r = base + (top - base) * k;
    out.push([center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)]);
  }
  return out;
}

/** SPLINE Fit: a smooth curve through the points (centripetal Catmull-Rom). */
export function fitSpline(points: readonly Pt[], closed = false, steps = SPLINE_STEPS): Pt[] {
  const pts = points.filter((p, i) => i === 0 || !same(p, points[i - 1] as Pt));
  if (pts.length < 2) throw new GeometryError('SHAPE');
  if (pts.length === 2) return [...pts];
  const n = pts.length;
  const at = (i: number): Pt =>
    closed
      ? (pts[((i % n) + n) % n] as Pt)
      : i < 0
        ? lerp(pts[0] as Pt, pts[1] as Pt, -1)
        : i >= n
          ? lerp(pts[n - 1] as Pt, pts[n - 2] as Pt, -1)
          : (pts[i] as Pt);
  const out: Pt[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.max(distance(p0, p1), EPS));
    const t2 = t1 + Math.sqrt(Math.max(distance(p1, p2), EPS));
    const t3 = t2 + Math.sqrt(Math.max(distance(p2, p3), EPS));
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
      const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  if (!closed) out.push(pts[n - 1] as Pt);
  return out;
}

/** SPLINE CV: a clamped cubic B-spline steered by the control vertices (through first and last). */
export function cvSpline(points: readonly Pt[], steps = SPLINE_STEPS): Pt[] {
  const n = points.length;
  if (n < 2) throw new GeometryError('SHAPE');
  const degree = Math.min(3, n - 1);
  const knots: number[] = [];
  const inner = n - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= inner; i++) knots.push(i / (inner + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  const basis = (i: number, k: number, u: number): number => {
    if (k === 0) {
      const lo = knots[i] as number;
      const hi = knots[i + 1] as number;
      return (u >= lo && u < hi) || (u === 1 && hi === 1 && lo < 1) ? 1 : 0;
    }
    const d1 = (knots[i + k] as number) - (knots[i] as number);
    const d2 = (knots[i + k + 1] as number) - (knots[i + 1] as number);
    const a = d1 > 0 ? ((u - (knots[i] as number)) / d1) * basis(i, k - 1, u) : 0;
    const b = d2 > 0 ? (((knots[i + k + 1] as number) - u) / d2) * basis(i + 1, k - 1, u) : 0;
    return a + b;
  };
  const count = Math.max(steps, steps * (n - degree));
  const out: Pt[] = [];
  for (let s = 0; s <= count; s++) {
    const u = s / count;
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      const w = basis(i, degree, u);
      x += w * (points[i] as Pt)[0];
      y += w * (points[i] as Pt)[1];
    }
    out.push([x, y]);
  }
  return out;
}

/** DIVIDE: the points that cut the curve into `segments` equal lengths. */
export function divideCurve(points: readonly Pt[], closed: boolean, segments: number): Pt[] {
  if (!(Number.isInteger(segments) && segments >= 2 && segments <= 32767)) {
    throw new GeometryError('SHAPE');
  }
  const total = curveLength(points, closed);
  if (total <= EPS) throw new GeometryError('SHAPE');
  const out: Pt[] = [];
  for (let i = closed ? 0 : 1; i < segments; i++) {
    out.push(pointAlong(points, closed, (total * i) / segments));
  }
  return out;
}

/** MEASURE: points every `step` along the curve from its start. */
export function measureCurve(points: readonly Pt[], closed: boolean, step: number): Pt[] {
  const total = curveLength(points, closed);
  if (!(step > 0) || total / step > 32767) throw new GeometryError('SHAPE');
  const out: Pt[] = [];
  for (let d = step; d < total - EPS; d += step) out.push(pointAlong(points, closed, d));
  return out;
}

// ---------- closed boundaries (HATCH, BOUNDARY, REGION) ----------

export function polygonArea(points: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Pt;
    const b = points[(i + 1) % points.length] as Pt;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

export function insidePolygon(points: readonly Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i] as Pt;
    const b = points[j] as Pt;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** A curve that closes on itself (flagged closed, or its last point back on the first). */
export function asLoop(points: readonly Pt[], closed: boolean, tolerance = 1e-6): Pt[] | null {
  if (points.length < 3) return null;
  const first = points[0] as Pt;
  const last = points[points.length - 1] as Pt;
  if (closed) return [...points];
  return distance(first, last) <= tolerance ? points.slice(0, -1) : null;
}

/** The smallest loop around a point (AutoCAD's «pick internal point», on closed objects). */
export function loopAround(loops: readonly (readonly Pt[])[], p: Pt): Pt[] | null {
  let best: { loop: readonly Pt[]; area: number } | null = null;
  for (const loop of loops) {
    if (loop.length < 3 || !insidePolygon(loop, p)) continue;
    const area = polygonArea(loop);
    if (!best || area < best.area) best = { loop, area };
  }
  return best ? [...best.loop] : null;
}

/**
 * REGION from pieces: open curves meeting end to end (within `tolerance`) joined into one closed
 * loop, or null when they do not close.
 */
export function chainLoop(pieces: readonly (readonly Pt[])[], tolerance: number): Pt[] | null {
  if (pieces.length === 0) return null;
  const left = pieces.slice(1).map((p) => [...p]);
  const out: Pt[] = [...(pieces[0] as Pt[])];
  while (left.length > 0) {
    const end = out[out.length - 1] as Pt;
    const i = left.findIndex(
      (p) =>
        distance(p[0] as Pt, end) <= tolerance || distance(p[p.length - 1] as Pt, end) <= tolerance,
    );
    if (i < 0) return null;
    const [next] = left.splice(i, 1) as [Pt[]];
    const ordered = distance(next[0] as Pt, end) <= tolerance ? next : [...next].reverse();
    out.push(...ordered.slice(1));
  }
  if (distance(out[0] as Pt, out[out.length - 1] as Pt) > tolerance) return null;
  const loop = out.slice(0, -1);
  return loop.length >= 3 ? loop : null;
}

/** Re-exported for the commands that need the closed ring of a curve. */
export { ring };
