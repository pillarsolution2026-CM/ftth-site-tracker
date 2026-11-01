import type { AsBuiltGeometry } from '@ftth/shared';

/**
 * Fit of project-CRS geometry (metres) into an SVG viewport. North is up: the SVG y axis grows
 * downwards, so y is flipped. No projection and no WGS 84 here (rule 5).
 */

export type XY = readonly [number, number];

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A single point (or a very short route) still gets a readable window. */
export const MIN_SPAN_M = 4;

export function positionsOf(geometry: AsBuiltGeometry): readonly XY[] {
  return geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
}

export function bboxOf(geometries: readonly (AsBuiltGeometry | null | undefined)[]): BBox | null {
  let box: BBox | null = null;
  for (const geometry of geometries) {
    if (!geometry) continue;
    for (const [x, y] of positionsOf(geometry)) {
      box = box
        ? {
            minX: Math.min(box.minX, x),
            minY: Math.min(box.minY, y),
            maxX: Math.max(box.maxX, x),
            maxY: Math.max(box.maxY, y),
          }
        : { minX: x, minY: y, maxX: x, maxY: y };
    }
  }
  return box;
}

export interface ViewTransform {
  /** SVG pixels per metre. */
  scale: number;
  width: number;
  height: number;
  project: (position: XY) => [number, number];
}

export function fitTransform(
  box: BBox,
  width: number,
  height: number,
  padding: number,
): ViewTransform {
  const spanX = Math.max(box.maxX - box.minX, MIN_SPAN_M);
  const spanY = Math.max(box.maxY - box.minY, MIN_SPAN_M);
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
  // Centre the drawing inside the viewport.
  const offsetX = (width - (box.maxX - box.minX) * scale) / 2;
  const offsetY = (height - (box.maxY - box.minY) * scale) / 2;
  return {
    scale,
    width,
    height,
    project: ([x, y]) => [
      (x - box.minX) * scale + offsetX,
      height - ((y - box.minY) * scale + offsetY),
    ],
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** SVG path data (`M x y L x y …`) of a route. */
export function pathData(positions: readonly XY[], transform: ViewTransform): string {
  return positions
    .map((position, index) => {
      const [x, y] = transform.project(position);
      return `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`;
    })
    .join(' ');
}

const NICE_STEPS = [1, 2, 5];

/** The largest round length (1, 2, 5 × 10^n metres) whose bar is at most `maxPx` wide. */
export function scaleBar(scale: number, maxPx: number): { metres: number; px: number } {
  const maxMetres = maxPx / scale;
  let best = 0;
  for (let power = -3; power <= 7; power += 1) {
    for (const step of NICE_STEPS) {
      const candidate = step * 10 ** power;
      if (candidate <= maxMetres) best = candidate;
    }
  }
  return { metres: best, px: best * scale };
}
