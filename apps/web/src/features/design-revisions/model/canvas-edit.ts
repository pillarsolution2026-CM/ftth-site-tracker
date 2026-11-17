import type { CreateDrawingCorrectionRequest } from '@ftth/shared';
import { boxThrough, rotationAbout, translation, type Affine } from './affine';
import { moveEntities, type DrawingPreview } from './drawing-preview';
import { boxOf, TEXT_WIDTH_FACTOR, type DrawingScene } from './drawing-scene';
import type { Bounds } from './view-transform';

/**
 * The drawing's edit mode (ADR-047): the project manager picks items on the canvas and changes
 * them; the edits stay in the page (drawn at once) until «حفظ» sends them as corrections, all at
 * once, or «إلغاء» drops them. The original drawing is never changed.
 */
export type EditTool = 'layer' | 'text' | 'move' | 'rotate';

export type CanvasEdit =
  | { kind: 'move_layer'; handle: string; toLayer: string }
  | { kind: 'set_text'; handle: string; text: string }
  | { kind: 'move_item'; handle: string; dx: number; dy: number }
  | { kind: 'rotate_item'; handle: string; x: number; y: number; angle: number };

/** DXF types whose text a `set_text` may replace (the extraction keeps these as texts). */
const TEXT_KINDS = new Set(['TEXT', 'MTEXT']);

export function isTextEntity(scene: DrawingScene, index: number): boolean {
  const entity = scene.view.entities[index];
  return entity !== undefined && TEXT_KINDS.has(entity.kind) && entity.texts.length > 0;
}

/** The move / turn an edit makes, or null for an edit that moves nothing. */
export function stepOf(edit: CanvasEdit): Affine | null {
  if (edit.kind === 'move_item') return translation(edit.dx, edit.dy);
  if (edit.kind === 'rotate_item') return rotationAbout(edit.x, edit.y, edit.angle);
  return null;
}

/**
 * A later layer or text edit of the same handle replaces the earlier one; moves and turns add up
 * (each is kept, in order).
 */
export function addEdits(edits: readonly CanvasEdit[], added: readonly CanvasEdit[]): CanvasEdit[] {
  const key = (edit: CanvasEdit) => `${edit.kind}\u0000${edit.handle}`;
  const replaced = new Set(added.filter((edit) => stepOf(edit) === null).map(key));
  return [...edits.filter((edit) => !replaced.has(key(edit))), ...added];
}

/** The edits as correction requests, in the order made. */
export function editRequests(edits: readonly CanvasEdit[]): CreateDrawingCorrectionRequest[] {
  return edits.map((edit) => ({ correction: { ...edit }, problem: null }));
}

/** Rounds a coordinate or angle to what a drawing keeps (micro-units), so requests stay short. */
export const roundCoord = (value: number) => Math.round(value * 1e6) / 1e6;

/** One move edit per handle. */
export function moveEdits(handles: readonly string[], dx: number, dy: number): CanvasEdit[] {
  return handles.map((handle) => ({
    kind: 'move_item',
    handle,
    dx: roundCoord(dx),
    dy: roundCoord(dy),
  }));
}

/** One turn edit per handle, the angle brought into ±360. */
export function rotateEdits(
  handles: readonly string[],
  x: number,
  y: number,
  angle: number,
): CanvasEdit[] {
  const turned = roundCoord(((angle % 360) + 360) % 360);
  const normal = turned > 180 ? turned - 360 : turned;
  return handles.map((handle) => ({
    kind: 'rotate_item',
    handle,
    x: roundCoord(x),
    y: roundCoord(y),
    angle: normal,
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
  /** Moved / turned entities are picked where they are drawn now. */
  transformOf: ReadonlyMap<number, Affine> = new Map(),
): number[] {
  const minX = Math.min(band.x0, band.x1);
  const maxX = Math.max(band.x0, band.x1);
  const minY = Math.min(band.y0, band.y1);
  const maxY = Math.max(band.y0, band.y1);
  const crossing = isCrossing(band);
  const out: number[] = [];
  const count = scene.view.entities.length;
  for (let index = 0; index < count; index++) {
    const drawn = tightBox(scene, index);
    if (drawn === null) continue;
    const moved = transformOf.get(index);
    const box = moved ? boxThrough(moved, drawn) : drawn;
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
  const transformOf = new Map(preview.transformOf);
  for (const edit of edits) {
    const indexes = scene.byHandle.get(edit.handle) ?? [];
    const step = stepOf(edit);
    if (step) {
      moveEntities(scene, transformOf, edit.handle, step);
    } else if (edit.kind === 'move_layer') {
      const target = scene.layerByName.get(edit.toLayer);
      if (target === undefined) continue;
      for (const index of indexes) layerOf.set(index, target);
    } else if (edit.kind === 'set_text') {
      for (const index of indexes) textOf.set(index, edit.text);
    }
  }
  return { ...preview, layerOf, textOf, transformOf };
}
