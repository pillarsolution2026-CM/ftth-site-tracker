import { applyAffine, type Affine } from './affine';

/**
 * Polyline arc segments as DXF keeps them (ADR-062, owner item 33): the bulge of vertex i is the
 * tangent of a quarter of the included angle of the arc from vertex i to vertex i + 1 (0 = a
 * straight segment, > 0 counter-clockwise, ±1 = a half circle).
 */

export interface Xy {
  x: number;
  y: number;
}

export interface BulgeVertex {
  x: number;
  y: number;
  bulge: number;
}

const EPS = 1e-12;

/** The middle of the segment from `a` to `b` with `bulge` (on the arc for an arc segment). */
export function segmentMid(a: Xy, b: Xy, bulge: number): Xy {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (Math.abs(bulge) < EPS) return { x: mx, y: my };
  // The sagitta is bulge × half the chord, to the right of a → b for a counter-clockwise arc.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const half = Math.hypot(dx, dy) / 2;
  if (half < EPS) return { x: mx, y: my };
  const s = bulge * half;
  return { x: mx + (s * dy) / (2 * half), y: my - (s * dx) / (2 * half) };
}

/** The bulge of the arc from `a` to `b` through `p`; 0 when `p` is on the chord's line. */
export function bulgeThrough(a: Xy, b: Xy, p: Xy): number {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < EPS || Math.abs(cross) < EPS * Math.max(1, chord * chord)) return 0;
  // The angle at p over the chord is π − θ/2 (θ the included angle): bulge = tan((π − ∠apb) / 2).
  const ua = { x: a.x - p.x, y: a.y - p.y };
  const ub = { x: b.x - p.x, y: b.y - p.y };
  const angle = Math.atan2(Math.abs(ua.x * ub.y - ua.y * ub.x), ua.x * ub.x + ua.y * ub.y);
  const magnitude = Math.tan((Math.PI - angle) / 2);
  // p to the right of a → b: the arc runs counter-clockwise.
  return cross < 0 ? magnitude : -magnitude;
}

/** The arc of a segment: centre, radius and the start / end angles (radians, the turn's way). */
function segmentArc(a: Xy, b: Xy, bulge: number) {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // The centre is to the left of a → b for a counter-clockwise arc under a half circle.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const d = (chord / 2) * (1 / Math.tan(theta / 2));
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const c = { x: mx + nx * d, y: my + ny * d };
  return { c, r, start: Math.atan2(a.y - c.y, a.x - c.x), theta };
}

/** Steps of a full circle when an arc segment is turned into points. */
const CIRCLE_STEPS = 64;

/** A polyline's points with its arc segments turned into short segments (the drawn path). */
export function flattenVertices(
  vertices: readonly BulgeVertex[],
  closed: boolean,
): [number, number][] {
  const out: [number, number][] = [];
  const n = vertices.length;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = vertices[i] as BulgeVertex;
    const b = vertices[(i + 1) % n] as BulgeVertex;
    if (i === 0) out.push([a.x, a.y]);
    if (Math.abs(a.bulge) >= EPS && Math.hypot(b.x - a.x, b.y - a.y) > EPS) {
      const { c, r, start, theta } = segmentArc(a, b, a.bulge);
      const steps = Math.max(2, Math.ceil((Math.abs(theta) / (2 * Math.PI)) * CIRCLE_STEPS));
      for (let k = 1; k < steps; k++) {
        const t = start + (theta * k) / steps;
        out.push([c.x + r * Math.cos(t), c.y + r * Math.sin(t)]);
      }
    }
    out.push([b.x, b.y]);
  }
  if (n === 1) out.push([(vertices[0] as BulgeVertex).x, (vertices[0] as BulgeVertex).y]);
  return out;
}

/** Vertices where a move / turn / mirror / scale puts them (a mirror turns the arcs around). */
export function transformVertices(
  vertices: readonly BulgeVertex[],
  t: Affine,
): BulgeVertex[] {
  const flip = t[0] * t[3] - t[1] * t[2] < 0 ? -1 : 1;
  return vertices.map((v) => {
    const p = applyAffine(t, v.x, v.y);
    return { x: p.x, y: p.y, bulge: v.bulge * flip };
  });
}

/** True when a vertex has an arc segment after it. */
export const hasArcs = (vertices: readonly BulgeVertex[]): boolean =>
  vertices.some((v) => Math.abs(v.bulge) >= EPS);
