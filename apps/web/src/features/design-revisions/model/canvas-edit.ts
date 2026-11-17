import type { CreateDrawingCorrectionRequest } from '@ftth/shared';
import type { DrawingPreview } from './drawing-preview';
import { boxOf, TEXT_WIDTH_FACTOR, type DrawingScene } from './drawing-scene';
import type { Bounds } from './view-transform';

/**
 * The drawing's edit mode (ADR-047): the project manager picks items on the canvas and changes
 * them; the edits stay in the page (drawn at once) until «حفظ» sends them as corrections, all at
 * once, or «إلغاء» drops them. The original drawing is never changed.
 */
export type EditTool = 'layer' | 'text';

export type CanvasEdit =
  | { kind: 'move_layer'; handle: string; toLayer: string }
  | { kind: 'set_text'; handle: string; text: string };

/** DXF types whose text a `set_text` may replace (the extraction keeps these as texts). */
const TEXT_KINDS = new Set(['TEXT', 'MTEXT']);

export function isTextEntity(scene: DrawingScene, index: number): boolean {
  const entity = scene.view.entities[index];
  return entity !== undefined && TEXT_KINDS.has(entity.kind) && entity.texts.length > 0;
}

/** One edit per kind and handle: a later edit of the same thing replaces the earlier one. */
export function addEdits(edits: readonly CanvasEdit[], added: readonly CanvasEdit[]): CanvasEdit[] {
  const key = (edit: CanvasEdit) => `${edit.kind}\u0000${edit.handle}`;
  const replaced = new Set(added.map(key));
  return [...edits.filter((edit) => !replaced.has(key(edit))), ...added];
}

/** The edits as correction requests, in the order made. */
export function editRequests(edits: readonly CanvasEdit[]): CreateDrawingCorrectionRequest[] {
  return edits.map((edit) => ({
    correction:
      edit.kind === 'move_layer'
        ? { kind: 'move_layer', handle: edit.handle, toLayer: edit.toLayer }
        : { kind: 'set_text', handle: edit.handle, text: edit.text },
    problem: null,
  }));
}

/** The handles of chosen entities, each once (an INSERT's shapes share one handle). */
export function handlesOf(scene: DrawingScene, chosen: Iterable<number>): string[] {
  const out = new Set<string>();
  for (const index of chosen) {
    const handle = scene.view.entities[index]?.handle;
    if (handle) out.add(handle);
  }
  return [...out];
}

export interface Band {
  /** Drawing coordinates of the corner pressed first and of the pointer now. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * AutoCAD's rule: dragged to the right, a window takes what is wholly inside; dragged to the left,
 * a crossing box also takes what it touches.
 */
export const isCrossing = (band: Band) => band.x1 < band.x0;

export function entitiesInBand(
  scene: DrawingScene,
  band: Band,
  isShown: (index: number) => boolean,
): number[] {
  const minX = Math.min(band.x0, band.x1);
  const maxX = Math.max(band.x0, band.x1);
  const minY = Math.min(band.y0, band.y1);
  const maxY = Math.max(band.y0, band.y1);
  const crossing = isCrossing(band);
  const out: number[] = [];
  const count = scene.view.entities.length;
  for (let index = 0; index < count; index++) {
    const box = tightBox(scene, index);
    if (box === null) continue;
    const inside = box.minX >= minX && box.maxX <= maxX && box.minY >= minY && box.maxY <= maxY;
    const touches = box.maxX >= minX && box.minX <= maxX && box.maxY >= minY && box.minY <= maxY;
    if ((crossing ? touches : inside) && isShown(index)) out.push(index);
  }
  return out;
}

/**
 * The box of what is drawn: the paths, and each text's rotated box as the canvas draws it (the
 * scene's culling boxes reach far around texts on purpose). null: nothing drawn.
 */
function tightBox(scene: DrawingScene, index: number): Bounds | null {
  const entity = scene.view.entities[index];
  if (!entity) return null;
  if (entity.texts.length === 0) return entity.paths.length > 0 ? boxOf(scene, index) : null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const path of entity.paths) {
    for (let i = 0; i + 1 < path.length; i += 2) add(path[i] as number, path[i + 1] as number);
  }
  for (const text of entity.texts) {
    const rad = (text.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const width = Math.max(text.height, text.text.length * text.height * TEXT_WIDTH_FACTOR * 0.75);
    for (const [u, v] of [
      [0, 0],
      [width, 0],
      [0, text.height],
      [width, text.height],
    ] as const) {
      add(text.x + u * cos - v * sin, text.y + u * sin + v * cos);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** The saved corrections' preview with the unsaved edits drawn on top. */
export function previewWithEdits(
  scene: DrawingScene,
  preview: DrawingPreview,
  edits: readonly CanvasEdit[],
): DrawingPreview {
  if (edits.length === 0) return preview;
  const layerOf = new Map(preview.layerOf);
  const textOf = new Map(preview.textOf);
  for (const edit of edits) {
    const indexes = scene.byHandle.get(edit.handle) ?? [];
    if (edit.kind === 'move_layer') {
      const target = scene.layerByName.get(edit.toLayer);
      if (target === undefined) continue;
      for (const index of indexes) layerOf.set(index, target);
    } else {
      for (const index of indexes) textOf.set(index, edit.text);
    }
  }
  return { ...preview, layerOf, textOf };
}
