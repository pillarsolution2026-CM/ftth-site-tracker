import type { DrawingViewEntity } from '@ftth/shared';
import type { DrawingProblemCode, DrawingProblemItem, DrawingProblemView } from '@ftth/shared';
import { boxOf, TEXT_WIDTH_FACTOR, type DrawingScene } from './drawing-scene';
import { applyAffine, invert, type Affine } from './affine';
import { placeKey } from './corrections';
import { entityGridOf } from './entity-grid';

const NO_TRANSFORMS: ReadonlyMap<number, Affine> = new Map();
const NO_CURVES: ReadonlyMap<number, { points: readonly (readonly [number, number])[] }> =
  new Map();
import { toScreen, type Size, type ViewTransform } from './view-transform';

export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to a text's (estimated) rotated box; 0 inside it. */
function distToText(x: number, y: number, text: DrawingViewEntity['texts'][number]): number {
  const rad = (text.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = x - text.x;
  const dy = y - text.y;
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const width = Math.max(text.height, text.text.length * text.height * TEXT_WIDTH_FACTOR * 0.75);
  const ox = Math.max(0 - lx, 0, lx - width);
  const oy = Math.max(0 - ly, 0, ly - text.height);
  return Math.hypot(ox, oy);
}

/** Smallest distance from a drawing point to any path segment or text of the entity. */
export function distToEntity(entity: DrawingViewEntity, x: number, y: number): number {
  let best = Infinity;
  for (const path of entity.paths) {
    for (let i = 0; i + 3 < path.length; i += 2) {
      const d = distToSegment(
        x,
        y,
        path[i] as number,
        path[i + 1] as number,
        path[i + 2] as number,
        path[i + 3] as number,
      );
      if (d < best) best = d;
    }
  }
  for (const text of entity.texts) {
    const d = distToText(x, y, text);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The nearest shown entity within `tolerance` drawing units of the point, or null. Boxes reject
 * most entities before any path is walked.
 */
export function hitEntity(
  scene: DrawingScene,
  px: number,
  py: number,
  tolerance: number,
  isShown: (index: number) => boolean,
  /** Moved / turned entities (ADR-047) are hit where they are drawn now. */
  transformOf: ReadonlyMap<number, Affine> = NO_TRANSFORMS,
  /** Curves with new points (set_curve, ADR-051) are hit on those points. */
  curveOf: ReadonlyMap<number, { points: readonly (readonly [number, number])[] }> = NO_CURVES,
): number | null {
  let best: number | null = null;
  let bestDistance = tolerance;
  const entities = scene.view.entities;
  /** The equally near object with the higher index wins, as when every object was walked in order. */
  const takes = (d: number, i: number) =>
    d <= bestDistance && (d < bestDistance || best === null || i > best);
  for (const [i, curve] of curveOf) {
    if (!isShown(i)) continue;
    const pts = curve.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k] as readonly [number, number];
      const b = pts[k + 1] as readonly [number, number];
      const d = distToSegment(px, py, a[0], a[1], b[0], b[1]);
      if (takes(d, i)) {
        best = i;
        bestDistance = d;
      }
    }
  }
  const test = (i: number, x: number, y: number) => {
    const box = boxOf(scene, i);
    if (
      x < box.minX - bestDistance ||
      x > box.maxX + bestDistance ||
      y < box.minY - bestDistance ||
      y > box.maxY + bestDistance
    ) {
      return;
    }
    if (!isShown(i)) return;
    const entity = entities[i] as DrawingViewEntity;
    let d = distToEntity(entity, x, y);
    // A filled area (hatch, solid, wipeout) is under the pick inside it too (AutoCAD); a line
    // nearer the point still wins the plain pick.
    const inside = tolerance * 0.99;
    if (d > inside && FILLED.has(entity.kind) && insideFill(entity, x, y)) d = inside;
    if (takes(d, i)) {
      best = i;
      bestDistance = d;
    }
  };
  // The objects near the point come from the spatial index (zoomed far out, the nearest few).
  const reach = tolerance;
  for (const i of entityGridOf(scene).query(
    { minX: px - reach, minY: py - reach, maxX: px + reach, maxY: py + reach },
    { at: [px, py], limit: HIT_CANDIDATES },
  )) {
    if (curveOf.has(i) || transformOf.has(i)) continue;
    test(i, px, py);
  }
  // Moved / turned entities are hit where they are drawn now: test the point moved back.
  for (const i of transformOf.keys()) {
    if (curveOf.has(i)) continue;
    // A rigid move keeps distances: test the point moved back instead of the entity moved on.
    const at = applyAffine(invert(transformOf.get(i) as Affine), px, py);
    test(i, at.x, at.y);
  }
  return best;
}

const FILLED = new Set(['HATCH', 'SOLID', 'WIPEOUT']);

/** Is the point inside one of the entity's closed paths (even-odd, so islands stay holes)? */
export function insideFill(entity: DrawingViewEntity, x: number, y: number): boolean {
  let inside = false;
  for (const path of entity.paths) {
    const n = Math.floor(path.length / 2);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = path[i * 2] as number;
      const yi = path[i * 2 + 1] as number;
      const xj = path[j * 2] as number;
      const yj = path[j * 2 + 1] as number;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The most objects walked path by path for one pick (far out the nearest ones). */
const HIT_CANDIDATES = 400;

export interface ProblemMarker {
  key: string;
  code: DrawingProblemCode;
  handle: string;
  x: number;
  y: number;
  /** Answered by a correction in force: drawn as a green check instead of a red ring. */
  fixed: boolean;
  item: DrawingProblemItem;
}

/** One marker per problem place; `pending` holds the `code:handle` keys of corrected places. */
export function buildMarkers(
  problems: readonly DrawingProblemView[],
  pending: ReadonlySet<string>,
): ProblemMarker[] {
  const out: ProblemMarker[] = [];
  for (const problem of problems) {
    for (const item of problem.items) {
      out.push({
        key: `${problem.code}:${item.handle}`,
        code: problem.code,
        handle: item.handle,
        x: item.drawingX,
        y: item.drawingY,
        fixed: pending.has(placeKey(problem.code, item.handle)),
        item,
      });
    }
  }
  return out;
}

/** The marker whose symbol is under the screen point (symbols are a fixed size on screen). */
export function hitMarker(
  markers: readonly ProblemMarker[],
  tf: ViewTransform,
  size: Size,
  sx: number,
  sy: number,
  radiusPx: number,
): ProblemMarker | null {
  let best: ProblemMarker | null = null;
  let bestDistance = radiusPx;
  for (const marker of markers) {
    const p = toScreen(tf, size, marker.x, marker.y);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }
  return best;
}
