import type { DrawingView, DrawingViewEntity } from '@ftth/shared';
import type { Bounds } from './view-transform';

/**
 * The drawing view prepared for drawing (ADR-039): per-entity bounding boxes for culling, a lookup
 * by handle, and an origin that local (Path2D) coordinates are relative to, so large project
 * coordinates keep their precision in the canvas' 32-bit path storage.
 */
export interface DrawingScene {
  view: DrawingView;
  origin: { x: number; y: number };
  /** minX, minY, maxX, maxY per entity, in drawing units. */
  boxes: Float64Array;
  byHandle: ReadonlyMap<string, readonly number[]>;
  layerByName: ReadonlyMap<string, number>;
}

/** Text boxes are only estimated: reach ≈ characters × this × height. */
export const TEXT_WIDTH_FACTOR = 0.8;

export function entityBox(entity: DrawingViewEntity): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of entity.paths) {
    for (let i = 0; i + 1 < path.length; i += 2) {
      const x = path[i] as number;
      const y = path[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  for (const text of entity.texts) {
    const reach = Math.max(text.height, text.text.length * text.height * TEXT_WIDTH_FACTOR);
    if (text.x - reach < minX) minX = text.x - reach;
    if (text.x + reach > maxX) maxX = text.x + reach;
    if (text.y - reach < minY) minY = text.y - reach;
    if (text.y + reach > maxY) maxY = text.y + reach;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function buildScene(view: DrawingView): DrawingScene {
  const { extents } = view;
  const boxes = new Float64Array(view.entities.length * 4);
  const byHandle = new Map<string, number[]>();
  view.entities.forEach((entity, index) => {
    const box = entityBox(entity);
    boxes[index * 4] = box.minX;
    boxes[index * 4 + 1] = box.minY;
    boxes[index * 4 + 2] = box.maxX;
    boxes[index * 4 + 3] = box.maxY;
    const list = byHandle.get(entity.handle);
    if (list) list.push(index);
    else byHandle.set(entity.handle, [index]);
  });
  const layerByName = new Map<string, number>();
  view.layers.forEach((layer, index) => {
    if (!layerByName.has(layer.name)) layerByName.set(layer.name, index);
  });
  return {
    view,
    origin: { x: (extents.minX + extents.maxX) / 2, y: (extents.minY + extents.maxY) / 2 },
    boxes,
    byHandle,
    layerByName,
  };
}

export function boxOf(scene: DrawingScene, index: number): Bounds {
  const b = scene.boxes;
  return {
    minX: b[index * 4] as number,
    minY: b[index * 4 + 1] as number,
    maxX: b[index * 4 + 2] as number,
    maxY: b[index * 4 + 3] as number,
  };
}

/** Indices of entities whose box meets the visible rectangle (off-screen ones are not drawn). */
export function cullEntities(scene: DrawingScene, visible: Bounds): number[] {
  const out: number[] = [];
  const b = scene.boxes;
  for (let i = 0, n = b.length / 4; i < n; i++) {
    const o = i * 4;
    if (
      (b[o] as number) <= visible.maxX &&
      (b[o + 2] as number) >= visible.minX &&
      (b[o + 1] as number) <= visible.maxY &&
      (b[o + 3] as number) >= visible.minY
    ) {
      out.push(i);
    }
  }
  return out;
}

/** Colour of an entity: the layer's colour when moved by a correction or BYLAYER, else its own. */
export function resolveColor(
  entity: DrawingViewEntity,
  layers: DrawingView['layers'],
  layerIndex: number,
  moved: boolean,
): string {
  const layerColor = layers[layerIndex]?.color ?? '#000000';
  if (moved) return layerColor;
  return entity.color ?? layerColor;
}

/** The paper is white: near-white strokes would vanish, so they are drawn dark. */
export function paperColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 235 ? '#333333' : hex;
}
