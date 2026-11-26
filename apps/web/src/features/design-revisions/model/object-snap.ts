import { applyAffine, type Affine } from './affine';
import type { DrawingPreview } from './drawing-preview';
import type { DrawingScene } from './drawing-scene';

/**
 * AutoCAD's object snaps, 2D only (owner 2026-11-26, item 14): the 14 modes of the Object Snap
 * drop-down in AutoCAD's order, their OSMODE bits, and the search for the snap point near the
 * pointer within the aperture. Pure: the drawing comes in, a point (and what snapped) goes out.
 */

export type Pt = readonly [number, number];

export type SnapMode =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'geometricCenter'
  | 'node'
  | 'quadrant'
  | 'intersection'
  | 'extension'
  | 'insertion'
  | 'perpendicular'
  | 'tangent'
  | 'nearest'
  | 'apparentIntersection'
  | 'parallel';

/** The modes as AutoCAD lists them in the Object Snap drop-down and the Drafting Settings. */
export const SNAP_MODES: readonly SnapMode[] = [
  'endpoint',
  'midpoint',
  'center',
  'geometricCenter',
  'node',
  'quadrant',
  'intersection',
  'extension',
  'insertion',
  'perpendicular',
  'tangent',
  'nearest',
  'apparentIntersection',
  'parallel',
];

/** AutoCAD's OSMODE bit of each mode. */
export const OSMODE_BIT: Readonly<Record<SnapMode, number>> = {
  endpoint: 1,
  midpoint: 2,
  center: 4,
  node: 8,
  quadrant: 16,
  intersection: 32,
  insertion: 64,
  perpendicular: 128,
  tangent: 256,
  nearest: 512,
  geometricCenter: 1024,
  apparentIntersection: 2048,
  extension: 4096,
  parallel: 8192,
};

/** The one-time override words typed at a point prompt (END, MID, …), as AutoCAD. */
export const SNAP_OVERRIDE: Readonly<Record<string, SnapMode | 'none'>> = {
  END: 'endpoint',
  MID: 'midpoint',
  CEN: 'center',
  GCE: 'geometricCenter',
  NOD: 'node',
  QUA: 'quadrant',
  INT: 'intersection',
  EXT: 'extension',
  INS: 'insertion',
  PER: 'perpendicular',
  TAN: 'tangent',
  NEA: 'nearest',
  APP: 'apparentIntersection',
  PAR: 'parallel',
  NON: 'none',
  NONE: 'none',
};

/** The override word typed (`end`, `ENDpoint`, `_mid`…) → its mode; null when it is none. */
export function overrideOf(word: string): SnapMode | 'none' | null {
  const w = word.trim().replace(/^_/, '').toUpperCase();
  if (w.length < 3) return null;
  return SNAP_OVERRIDE[w.slice(0, 3)] ?? SNAP_OVERRIDE[w] ?? null;
}

/** AutoCAD's default OSMODE 4133: Endpoint, Center, Intersection, Extension. */
export const DEFAULT_OSMODE = 4133;

export const modesOf = (osmode: number): Set<SnapMode> =>
  new Set(SNAP_MODES.filter((mode) => (osmode & OSMODE_BIT[mode]) !== 0));
export const osmodeOf = (modes: ReadonlySet<SnapMode>): number =>
  [...modes].reduce((sum, mode) => sum | OSMODE_BIT[mode], 0);

/** Something drawn that a snap can find, in drawing units. */
export type SnapShape =
  | { kind: 'path'; points: Pt[]; closed: boolean }
  | { kind: 'circle'; center: Pt; radius: number }
  /** Counter-clockwise from `start` to `end`, radians. */
  | { kind: 'arc'; center: Pt; radius: number; start: number; end: number }
  | { kind: 'node'; at: Pt }
  | { kind: 'insertion'; at: Pt };

/** A point hovered long enough to be acquired (tracking, extension) and the line it ends. */
export interface Acquired {
  at: Pt;
  /** For an endpoint: the direction the line runs out of it (extension). */
  dir: Pt | null;
}

export interface SnapHit {
  mode: SnapMode;
  at: Pt;
  /** Extension / parallel: where the dotted path starts. */
  from?: Pt;
}

export interface SnapQuery {
  cursor: Pt;
  /** The aperture in drawing units (AutoCAD's APERTURE pixels / scale). */
  aperture: number;
  modes: ReadonlySet<SnapMode>;
  /** The last point of the command (perpendicular, tangent, parallel); null at a first point. */
  anchor: Pt | null;
  acquired?: readonly Acquired[];
  /** Parallel: directions of lines hovered long enough. */
  parallels?: readonly Pt[];
}

// ---------- vectors ----------

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a: Pt): Pt => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};
const TAU = Math.PI * 2;
const norm = (angle: number) => ((angle % TAU) + TAU) % TAU;

/** Closest point of segment ab to p, and its parameter (0 at a, 1 at b). */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { at: Pt; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return { at: add(a, mul(ab, t)), t };
}

/** Foot of the perpendicular from p onto the infinite line through a and b. */
export function footOnLine(p: Pt, a: Pt, b: Pt): { at: Pt; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
  return { at: add(a, mul(ab, t)), t };
}

/** Intersection of lines a1a2 and b1b2 with both parameters; null when parallel. */
export function lineLine(
  a1: Pt,
  a2: Pt,
  b1: Pt,
  b2: Pt,
): { at: Pt; ta: number; tb: number } | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const d = cross(r, s);
  if (Math.abs(d) < 1e-12 * Math.max(1, len(r) * len(s))) return null;
  const q = sub(b1, a1);
  const ta = cross(q, s) / d;
  const tb = cross(q, r) / d;
  return { at: add(a1, mul(r, ta)), ta, tb };
}

/** Points where segment ab meets a circle; `t` along the segment. */
function segmentCircle(a: Pt, b: Pt, c: Pt, radius: number): { at: Pt; t: number }[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  const B = 2 * dot(f, d);
  const C = dot(f, f) - radius * radius;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return [];
  const root = Math.sqrt(disc);
  const out: { at: Pt; t: number }[] = [];
  for (const t of disc === 0 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
    if (t >= -1e-9 && t <= 1 + 1e-9) out.push({ at: add(a, mul(d, t)), t });
  }
  return out;
}

function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d === 0 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m = add(c1, mul(sub(c2, c1), a / d));
  const n: Pt = [-(c2[1] - c1[1]) / d, (c2[0] - c1[0]) / d];
  return h === 0 ? [m] : [add(m, mul(n, h)), sub(m, mul(n, h))];
}

/** Circle through three points; null when they are on one line. */
export function circleOf3(a: Pt, b: Pt, c: Pt): { center: Pt; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const center: Pt = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
  return { center, radius: dist(center, a) };
}

/** The angle is on the arc (counter-clockwise from start to end). */
export const onSweep = (angle: number, start: number, end: number) => {
  const sweep = norm(end - start) || TAU;
  return norm(angle - start) <= sweep + 1e-9;
};
const angleOf = (c: Pt, p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const polar = (c: Pt, r: number, a: number): Pt => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** Area centroid of a closed polygon (AutoCAD's Geometric Center); null when it has no area. */
export function centroid(points: readonly Pt[]): Pt | null {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Pt;
    const q = points[(i + 1) % points.length] as Pt;
    const k = cross(p, q);
    area += k;
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  }
  if (Math.abs(area) < 1e-12) return null;
  return [cx / (3 * area), cy / (3 * area)];
}

// ---------- the drawing as snap shapes ----------

export interface SnapSource {
  scene: DrawingScene;
  preview: DrawingPreview;
  /** The entity is drawn (its layer on and thawed, not hidden, not erased). */
  isShown: (index: number) => boolean;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const flatPoints = (flat: readonly number[], step: Affine | undefined): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i] as number;
    const y = flat[i + 1] as number;
    if (step) {
      const p = applyAffine(step, x, y);
      out.push([p.x, p.y]);
    } else out.push([x, y]);
  }
  return out;
};

const isClosed = (points: Pt[]): { points: Pt[]; closed: boolean } => {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 2 && first && last && first[0] === last[0] && first[1] === last[1]) {
    return { points: points.slice(0, -1), closed: true };
  }
  return { points, closed: false };
};

const meets = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const boundsOf = (points: readonly Pt[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
};

/** A circle or an arc drawn as a polygon (the view's tessellation) back as a circle / arc. */
function roundShape(kind: string, points: Pt[]): SnapShape | null {
  if (points.length < 3) return null;
  const first = points[0] as Pt;
  const middle = points[Math.floor(points.length / 2)] as Pt;
  if (kind === 'CIRCLE') {
    const third = points[Math.floor(points.length / 3)] as Pt;
    const fit = circleOf3(first, third, middle);
    return fit ? { kind: 'circle', ...fit } : null;
  }
  const last = points[points.length - 1] as Pt;
  const fit = circleOf3(first, middle, last);
  if (!fit) return null;
  let start = angleOf(fit.center, first);
  let end = angleOf(fit.center, last);
  // Counter-clockwise from start to end must pass the middle (a mirrored arc runs the other way).
  if (!onSweep(angleOf(fit.center, middle), start, end)) [start, end] = [end, start];
  return { kind: 'arc', ...fit, start, end };
}

function entityShapes(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
  step: Affine | undefined,
): SnapShape[] {
  const entity = scene.view.entities[index];
  if (!entity) return [];
  const replaced = preview.curveOf.get(index);
  if (replaced) {
    const points = replaced.points.map((p) => {
      if (!step) return [p[0], p[1]] as Pt;
      const q = applyAffine(step, p[0], p[1]);
      return [q.x, q.y] as Pt;
    });
    return [{ kind: 'path', points, closed: replaced.closed }];
  }
  const out: SnapShape[] = [];
  if (entity.kind === 'TEXT' || entity.kind === 'MTEXT') {
    const text = entity.texts[0];
    if (text) {
      const p = step ? applyAffine(step, text.x, text.y) : { x: text.x, y: text.y };
      out.push({ kind: 'insertion', at: [p.x, p.y] });
    }
  }
  for (const flat of entity.paths) {
    const points = flatPoints(flat, step);
    if (entity.kind === 'POINT') {
      const at = points[0];
      if (at) out.push({ kind: 'node', at });
      continue;
    }
    if (entity.kind === 'CIRCLE' || entity.kind === 'ARC') {
      const round = roundShape(entity.kind, isClosed(points).points);
      if (round) {
        out.push(round);
        continue;
      }
    }
    out.push({ kind: 'path', ...isClosed(points) });
  }
  return out;
}

/** Everything drawn whose box meets `box`: the drawing (moved, trimmed), copies, added lines. */
export function shapesNear(source: SnapSource, box: Bounds): SnapShape[] {
  const { scene, preview, isShown } = source;
  const out: SnapShape[] = [];
  const b = scene.boxes;
  const count = scene.view.entities.length;
  for (let index = 0; index < count; index++) {
    if (preview.erased.has(index) || !isShown(index)) continue;
    const step = preview.transformOf.get(index);
    if (!step && !preview.curveOf.has(index)) {
      const o = index * 4;
      const own = {
        minX: b[o] as number,
        minY: b[o + 1] as number,
        maxX: b[o + 2] as number,
        maxY: b[o + 3] as number,
      };
      if (!meets(own, box)) continue;
    }
    for (const shape of entityShapes(scene, preview, index, step)) {
      if (meets(shapeBounds(shape), box)) out.push(shape);
    }
  }
  for (const copy of preview.copies) {
    if (!isShown(copy.index)) continue;
    for (const shape of entityShapes(scene, preview, copy.index, copy.transform)) {
      if (meets(shapeBounds(shape), box)) out.push(shape);
    }
  }
  for (const curve of preview.extraCurves) {
    const shape: SnapShape = {
      kind: 'path',
      points: flatPoints(curve.path, undefined),
      closed: curve.closed,
    };
    if (meets(shapeBounds(shape), box)) out.push(shape);
  }
  for (const text of preview.extraTexts) {
    const shape: SnapShape = { kind: 'insertion', at: [text.x, text.y] };
    if (meets(shapeBounds(shape), box)) out.push(shape);
  }
  for (const shape of preview.shapes) {
    if (shape.shape !== 'hatch' && shape.shape !== 'gradient' && shape.shape !== 'wipeout')
      continue;
    const s: SnapShape = {
      kind: 'path',
      points: shape.points.map((p) => [p[0], p[1]] as Pt),
      closed: true,
    };
    if (meets(shapeBounds(s), box)) out.push(s);
  }
  return out;
}

function shapeBounds(shape: SnapShape): Bounds {
  switch (shape.kind) {
    case 'path':
      return boundsOf(shape.points);
    case 'circle':
    case 'arc':
      return {
        minX: shape.center[0] - shape.radius,
        minY: shape.center[1] - shape.radius,
        maxX: shape.center[0] + shape.radius,
        maxY: shape.center[1] + shape.radius,
      };
    default:
      return { minX: shape.at[0], minY: shape.at[1], maxX: shape.at[0], maxY: shape.at[1] };
  }
}

// ---------- finding the snap ----------

type Segment = readonly [Pt, Pt];

const segmentsOf = (shape: SnapShape): Segment[] => {
  if (shape.kind !== 'path') return [];
  const out: Segment[] = [];
  const { points, closed } = shape;
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i] as Pt, points[i + 1] as Pt]);
  if (closed && points.length > 2) out.push([points[points.length - 1] as Pt, points[0] as Pt]);
  return out;
};

/** The pointer is on the round shape (within the aperture of its curve). */
const onRound = (shape: SnapShape, cursor: Pt, aperture: number) => {
  if (shape.kind !== 'circle' && shape.kind !== 'arc') return false;
  if (Math.abs(dist(cursor, shape.center) - shape.radius) > aperture) return false;
  return shape.kind === 'circle' || onSweep(angleOf(shape.center, cursor), shape.start, shape.end);
};

const onArc = (shape: SnapShape, p: Pt) =>
  shape.kind === 'circle' ||
  (shape.kind === 'arc' && onSweep(angleOf(shape.center, p), shape.start, shape.end));

/**
 * AutoCAD's order when several snaps are in the aperture: points (endpoint, midpoint,
 * intersection…) nearest first, then the snaps found by hovering a shape (center, geometric
 * center), then those that need the last point (perpendicular, tangent), the dotted paths
 * (extension, parallel), and Nearest last.
 */
const RANK: Readonly<Record<SnapMode, number>> = {
  endpoint: 0,
  midpoint: 0,
  node: 0,
  quadrant: 0,
  intersection: 0,
  apparentIntersection: 0,
  insertion: 0,
  center: 1,
  geometricCenter: 1,
  perpendicular: 2,
  tangent: 2,
  extension: 3,
  parallel: 3,
  nearest: 4,
};

/**
 * Every snap the enabled modes find within the aperture of the pointer, best first (Tab steps
 * through them as in AutoCAD).
 */
export function findSnaps(shapes: readonly SnapShape[], query: SnapQuery): SnapHit[] {
  const { cursor, aperture, modes, anchor } = query;
  const hits: SnapHit[] = [];
  const near = (p: Pt) => dist(p, cursor) <= aperture;
  const push = (mode: SnapMode, at: Pt, from?: Pt) => {
    if (modes.has(mode)) hits.push(from ? { mode, at, from } : { mode, at });
  };
  const hovered: { seg: Segment; shape: SnapShape }[] = [];
  const rounds: SnapShape[] = [];

  for (const shape of shapes) {
    if (shape.kind === 'node') {
      if (near(shape.at)) push('node', shape.at);
      continue;
    }
    if (shape.kind === 'insertion') {
      if (near(shape.at)) push('insertion', shape.at);
      continue;
    }
    if (shape.kind === 'circle' || shape.kind === 'arc') {
      const { center, radius } = shape;
      const hover = onRound(shape, cursor, aperture);
      if (near(center) || hover) push('center', center);
      for (let q = 0; q < 4; q++) {
        const at = polar(center, radius, (q * Math.PI) / 2);
        if (near(at) && onArc(shape, at)) push('quadrant', at);
      }
      if (shape.kind === 'arc') {
        const a = polar(center, radius, shape.start);
        const b = polar(center, radius, shape.end);
        const mid = polar(center, radius, shape.start + norm(shape.end - shape.start) / 2);
        if (near(a)) push('endpoint', a);
        if (near(b)) push('endpoint', b);
        if (near(mid)) push('midpoint', mid);
      }
      if (hover) {
        rounds.push(shape);
        const towards = unit(sub(cursor, center));
        push('nearest', add(center, mul(towards, radius)));
        if (anchor && modes.has('perpendicular')) {
          const dir = unit(sub(anchor, center));
          if (len(dir) > 0) {
            const both = [add(center, mul(dir, radius)), sub(center, mul(dir, radius))];
            const best = both
              .filter((p) => onArc(shape, p))
              .sort((p, q) => dist(p, cursor) - dist(q, cursor))[0];
            if (best) push('perpendicular', best);
          }
        }
        if (anchor && modes.has('tangent')) {
          const d = dist(anchor, center);
          if (d > radius) {
            const base = angleOf(center, anchor);
            const spread = Math.acos(radius / d);
            const both = [
              polar(center, radius, base + spread),
              polar(center, radius, base - spread),
            ];
            const best = both
              .filter((p) => onArc(shape, p))
              .sort((p, q) => dist(p, cursor) - dist(q, cursor))[0];
            if (best) push('tangent', best);
          }
        }
      }
      continue;
    }
    // A line or polyline: every vertex is an endpoint (AutoCAD), each segment has a midpoint.
    for (const p of shape.points) if (near(p)) push('endpoint', p);
    const segments = segmentsOf(shape);
    let onShape = false;
    for (const seg of segments) {
      const [a, b] = seg;
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (near(mid)) push('midpoint', mid);
      const closest = closestOnSegment(cursor, a, b);
      if (dist(closest.at, cursor) > aperture) continue;
      onShape = true;
      hovered.push({ seg, shape });
      push('nearest', closest.at);
      if (anchor && modes.has('perpendicular')) {
        const foot = footOnLine(anchor, a, b);
        if (foot.t >= 0 && foot.t <= 1 && dist(anchor, foot.at) > 0) push('perpendicular', foot.at);
      }
    }
    if (onShape && shape.closed && modes.has('geometricCenter')) {
      const c = centroid(shape.points);
      if (c) push('geometricCenter', c);
    }
  }

  // Intersections of what is under the pointer (segments with segments and circles).
  if (modes.has('intersection') || modes.has('apparentIntersection')) {
    for (let i = 0; i < hovered.length; i++) {
      const [a1, a2] = (hovered[i] as { seg: Segment }).seg;
      for (let j = i + 1; j < hovered.length; j++) {
        const [b1, b2] = (hovered[j] as { seg: Segment }).seg;
        const x = lineLine(a1, a2, b1, b2);
        if (!x || !near(x.at)) continue;
        const inside = x.ta >= -1e-9 && x.ta <= 1 + 1e-9 && x.tb >= -1e-9 && x.tb <= 1 + 1e-9;
        // Adjacent segments of one polyline meet at their vertex: that is an endpoint.
        const shared = [a1, a2].some((p) => [b1, b2].some((q) => dist(p, q) === 0));
        if (inside && !shared) push('intersection', x.at);
        else if (!inside) push('apparentIntersection', x.at);
      }
      for (const round of rounds) {
        if (round.kind !== 'circle' && round.kind !== 'arc') continue;
        for (const x of segmentCircle(a1, a2, round.center, round.radius)) {
          if (near(x.at) && onArc(round, x.at)) push('intersection', x.at);
        }
      }
    }
    for (let i = 0; i < rounds.length; i++) {
      const r1 = rounds[i] as SnapShape;
      for (let j = i + 1; j < rounds.length; j++) {
        const r2 = rounds[j] as SnapShape;
        if (r1.kind === 'path' || r2.kind === 'path') continue;
        if (
          r1.kind === 'node' ||
          r1.kind === 'insertion' ||
          r2.kind === 'node' ||
          r2.kind === 'insertion'
        ) {
          continue;
        }
        for (const at of circleCircle(r1.center, r1.radius, r2.center, r2.radius)) {
          if (near(at) && onArc(r1, at) && onArc(r2, at)) push('intersection', at);
        }
      }
    }
  }

  // Extension: the dotted path out of an acquired endpoint, along its line.
  if (modes.has('extension')) {
    for (const acquired of query.acquired ?? []) {
      if (!acquired.dir) continue;
      const foot = footOnLine(cursor, acquired.at, add(acquired.at, acquired.dir));
      if (foot.t > 0 && dist(foot.at, cursor) <= aperture) push('extension', foot.at, acquired.at);
    }
  }
  // Parallel: from the last point, along a line hovered long enough.
  if (anchor && modes.has('parallel')) {
    for (const dir of query.parallels ?? []) {
      const foot = footOnLine(cursor, anchor, add(anchor, dir));
      if (dist(foot.at, cursor) <= aperture && dist(foot.at, anchor) > aperture) {
        push('parallel', foot.at, anchor);
      }
    }
  }

  const seen = new Set<string>();
  return hits
    .sort((p, q) => RANK[p.mode] - RANK[q.mode] || dist(p.at, cursor) - dist(q.at, cursor))
    .filter((hit) => {
      const key = `${hit.mode}|${hit.at[0].toFixed(9)}|${hit.at[1].toFixed(9)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The snaps at the pointer: the shapes near it, then {@link findSnaps}. `query.aperture` also
 * sizes the search box.
 */
export function snapsAt(source: SnapSource, query: SnapQuery): SnapHit[] {
  const r = query.aperture;
  const [x, y] = query.cursor;
  const shapes = shapesNear(source, { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r });
  return findSnaps(shapes, query);
}

/** The direction a line runs out of an endpoint (for Extension), from the shapes near it. */
export function endDirection(shapes: readonly SnapShape[], at: Pt): Pt | null {
  for (const shape of shapes) {
    if (shape.kind !== 'path' || shape.closed || shape.points.length < 2) continue;
    const { points } = shape;
    const first = points[0] as Pt;
    const last = points[points.length - 1] as Pt;
    if (dist(first, at) < 1e-9) return unit(sub(first, points[1] as Pt));
    if (dist(last, at) < 1e-9) return unit(sub(last, points[points.length - 2] as Pt));
  }
  return null;
}

/** The direction of the segment under the pointer (Parallel acquires it). */
export function segmentDirection(
  shapes: readonly SnapShape[],
  cursor: Pt,
  aperture: number,
): Pt | null {
  let best: { d: number; dir: Pt } | null = null;
  for (const shape of shapes) {
    for (const [a, b] of segmentsOf(shape)) {
      const d = dist(closestOnSegment(cursor, a, b).at, cursor);
      if (d <= aperture && (!best || d < best.d)) best = { d, dir: unit(sub(b, a)) };
    }
  }
  return best?.dir ?? null;
}
