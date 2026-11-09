import type { DrawingCorrection } from '@ftth/shared';
import type { DrawingScene } from './drawing-scene';

/** Colour of a preview shape whose layer is not in the drawing view. */
export const FALLBACK_COLOR = '#333333';

export interface PreviewText {
  x: number;
  y: number;
  height: number;
  text: string;
  /** Index into the view's layers; -1 when the layer is not in the view (always shown). */
  layer: number;
  color: string;
}

export interface PreviewItem {
  x: number;
  y: number;
  layer: number;
  color: string;
}

/**
 * Corrections in force drawn on top of the view at once (ADR-039); the official result is only
 * the next build. Entities are addressed by index into the view's entity list.
 */
export interface DrawingPreview {
  /** Entity → layer index it moved to (colour and layer toggle follow the target layer). */
  layerOf: ReadonlyMap<number, number>;
  /** Entity → text that replaces its first text. */
  textOf: ReadonlyMap<number, string>;
  extraTexts: readonly PreviewText[];
  extraItems: readonly PreviewItem[];
  /** Entities joined by a merge_routes correction. */
  merged: ReadonlySet<number>;
}

export const EMPTY_PREVIEW: DrawingPreview = {
  layerOf: new Map(),
  textOf: new Map(),
  extraTexts: [],
  extraItems: [],
  merged: new Set(),
};

/** Text height of an added label that has none: 0.25 m, or 2.5 drawing units without a scale. */
export function defaultTextHeight(metresPerUnit: number | null): number {
  if (metresPerUnit === null || !(metresPerUnit > 0)) return 2.5;
  return 0.25 / metresPerUnit;
}

/**
 * Applies the corrections in force, oldest first (the list comes newest first). Withdrawn ones are
 * skipped; a handle or layer that is not in the view is ignored.
 */
export function applyCorrections(
  scene: DrawingScene,
  corrections: readonly DrawingCorrection[],
  textHeight: number,
): DrawingPreview {
  const layerOf = new Map<number, number>();
  const textOf = new Map<number, string>();
  const extraTexts: PreviewText[] = [];
  const extraItems: PreviewItem[] = [];
  const merged = new Set<number>();
  const layers = scene.view.layers;
  const layerIndex = (name: string) => scene.layerByName.get(name) ?? -1;
  const colorOf = (index: number) => layers[index]?.color ?? FALLBACK_COLOR;

  const active = corrections
    .filter((item) => item.withdrawnAt === null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const { correction } of active) {
    switch (correction.kind) {
      case 'move_layer': {
        const target = layerIndex(correction.toLayer);
        if (target < 0) break;
        for (const index of scene.byHandle.get(correction.handle) ?? []) layerOf.set(index, target);
        break;
      }
      case 'set_text':
        for (const index of scene.byHandle.get(correction.handle) ?? []) {
          textOf.set(index, correction.text);
        }
        break;
      case 'add_text': {
        const layer = layerIndex(correction.layer);
        extraTexts.push({
          x: correction.x,
          y: correction.y,
          height: correction.height ?? textHeight,
          text: correction.text,
          layer,
          color: colorOf(layer),
        });
        break;
      }
      case 'add_item': {
        const layer = layerIndex(correction.layer);
        extraItems.push({ x: correction.x, y: correction.y, layer, color: colorOf(layer) });
        break;
      }
      case 'merge_routes':
        for (const handle of correction.handles) {
          for (const index of scene.byHandle.get(handle) ?? []) merged.add(index);
        }
        break;
    }
  }
  return { layerOf, textOf, extraTexts, extraItems, merged };
}

/** Layer an entity is on now: the correction's target, else its own. */
export function effectiveLayer(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): number {
  return preview.layerOf.get(index) ?? (scene.view.entities[index]?.layer as number);
}
