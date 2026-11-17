import type { Bounds } from './view-transform';

/**
 * A move / turn of drawing points (ADR-047): x' = a·x + c·y + e, y' = b·x + d·y + f, the order of
 * the canvas' `transform(a, b, c, d, e, f)`.
 */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export const translation = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy];

/** Turn by `degrees` counter-clockwise (CAD convention) about (x, y). */
export function rotationAbout(x: number, y: number, degrees: number): Affine {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, x - x * cos + y * sin, y - x * sin - y * cos];
}

/** `first`, then `then`. */
export function compose(first: Affine, then: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = then;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

export function applyAffine(t: Affine, x: number, y: number): { x: number; y: number } {
  return { x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5] };
}

export function invert(t: Affine): Affine {
  const [a, b, c, d, e, f] = t;
  const det = a * d - b * c;
  if (det === 0) return IDENTITY;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** How far the transform turns, in degrees counter-clockwise. */
export const angleOf = (t: Affine) => (Math.atan2(t[1], t[0]) * 180) / Math.PI;

/** The box around a box's four corners once transformed. */
export function boxThrough(t: Affine, box: Bounds): Bounds {
  const corners = [
    applyAffine(t, box.minX, box.minY),
    applyAffine(t, box.maxX, box.minY),
    applyAffine(t, box.minX, box.maxY),
    applyAffine(t, box.maxX, box.maxY),
  ];
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}
