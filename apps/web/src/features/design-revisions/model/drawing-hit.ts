import type { DrawingViewEntity } from '@ftth/shared';
import type { DrawingProblemCode, DrawingProblemItem, DrawingProblemView } from '@ftth/shared';
import { boxOf, TEXT_WIDTH_FACTOR, type DrawingScene } from './drawing-scene';
import { placeKey } from './corrections';
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
  x: number,
  y: number,
  tolerance: number,
  isShown: (index: number) => boolean,
): number | null {
  let best: number | null = null;
  let bestDistance = tolerance;
  const entities = scene.view.entities;
  for (let i = 0; i < entities.length; i++) {
    const box = boxOf(scene, i);
    if (
      x < box.minX - tolerance ||
      x > box.maxX + tolerance ||
      y < box.minY - tolerance ||
      y > box.maxY + tolerance
    ) {
      continue;
    }
    if (!isShown(i)) continue;
    const d = distToEntity(entities[i] as DrawingViewEntity, x, y);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}

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
