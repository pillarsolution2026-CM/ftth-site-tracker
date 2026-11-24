import type { CreateDrawingCorrectionRequest, DrawingCorrectionInput } from '@ftth/shared';
import { boxThrough, type Affine } from './affine';
import { applyInputs, stepOfInput, type DrawingPreview } from './drawing-preview';
import { boxOf, TEXT_WIDTH_FACTOR, type DrawingScene } from './drawing-scene';
import type { Bounds } from './view-transform';

/**
 * The drawing's edit mode, an AutoCAD-like workspace (ADR-047, ADR-050, ADR-051): the project
 * manager runs commands on the canvas; the edits stay in the page (drawn at once) until «حفظ» sends
 * them as corrections, all at once, or «إلغاء» drops them. The original drawing is never changed.
 */

/** An unsaved edit: any correction the workspace makes. */
export type CanvasEdit = Exclude<DrawingCorrectionInput, { kind: 'dismiss_problem' }>;

/** DXF types whose text a `set_text` may replace (the extraction keeps these as texts). */
const TEXT_KINDS = new Set(['TEXT', 'MTEXT']);

export function isTextEntity(scene: DrawingScene, index: number): boolean {
  const entity = scene.view.entities[index];
  return entity !== undefined && TEXT_KINDS.has(entity.kind) && entity.texts.length > 0;
}

/** The move / turn / mirror / scale an edit makes, or null for an edit that moves nothing. */
export const stepOf = (edit: CanvasEdit): Affine | null => stepOfInput(edit);

/** Edits that a later edit of the same handle replaces (the others add up, in order). */
const REPLACED_BY_KIND = new Set<CanvasEdit['kind']>([
  'move_layer',
  'set_text',
  'set_style',
  'set_order',
]);

export function addEdits(edits: readonly CanvasEdit[], added: readonly CanvasEdit[]): CanvasEdit[] {
  const key = (edit: CanvasEdit) =>
    REPLACED_BY_KIND.has(edit.kind) && 'handle' in edit ? `${edit.kind}\u0000${edit.handle}` : null;
  const replaced = new Set(added.map(key).filter((k): k is string => k !== null));
  return [...edits.filter((edit) => !replaced.has(key(edit) ?? '\u0001')), ...added];
}

/** The edits as correction requests, in the order made. */
export function editRequests(edits: readonly CanvasEdit[]): CreateDrawingCorrectionRequest[] {
  return edits.map((edit) => ({ correction: { ...edit }, problem: null }));
}

/** Rounds a coordinate or angle to what a drawing keeps (micro-units), so requests stay short. */
export const roundCoord = (value: number) => Math.round(value * 1e6) / 1e6;

export interface Point {
  x: number;
  y: number;
}

const r = roundCoord;

export function moveEdits(handles: readonly string[], dx: number, dy: number): CanvasEdit[] {
  return handles.map((handle) => ({ kind: 'move_item', handle, dx: r(dx), dy: r(dy) }));
}

export function copyEdits(handles: readonly string[], dx: number, dy: number): CanvasEdit[] {
  return handles.map((handle) => ({ kind: 'copy_item', handle, dx: r(dx), dy: r(dy) }));
}

/** One turn edit per handle, the angle brought into ±180. */
export function rotateEdits(
  handles: readonly string[],
  x: number,
  y: number,
  angle: number,
): CanvasEdit[] {
  const turned = r(((angle % 360) + 360) % 360);
  const normal = turned > 180 ? turned - 360 : turned;
  return handles.map((handle) => ({
    kind: 'rotate_item',
    handle,
    x: r(x),
    y: r(y),
    angle: normal,
  }));
}

export function mirrorEdits(handles: readonly string[], a: Point, b: Point): CanvasEdit[] {
  return handles.map((handle) => ({
    kind: 'mirror_item',
    handle,
    x1: r(a.x),
    y1: r(a.y),
    x2: r(b.x),
    y2: r(b.y),
  }));
}

export function scaleEdits(
  handles: readonly string[],
  x: number,
  y: number,
  factor: number,
): CanvasEdit[] {
  return handles.map((handle) => ({ kind: 'scale_item', handle, x: r(x), y: r(y), factor }));
}

export const eraseEdits = (handles: readonly string[]): CanvasEdit[] =>
  handles.map((handle) => ({ kind: 'erase_item', handle }));

export function curveEdit(layer: string, points: readonly Point[], closed: boolean): CanvasEdit {
  return {
    kind: 'add_curve',
    layer,
    points: points.map((p) => [r(p.x), r(p.y)] as [number, number]),
    closed,
  };
}

/** A curve's new points (Trim, Fillet, Stretch; ADR-051). */
export function setCurveEdit(
  handle: string,
  points: readonly (readonly [number, number])[],
  closed: boolean,
): CanvasEdit {
  return {
    kind: 'set_curve',
    handle,
    points: points.map((p) => [r(p[0]), r(p[1])] as [number, number]),
    closed,
  };
}

/** A drawn curve from [x, y] points (Offset, Circle, Arc, Rectangle, a split by Trim). */
export function pointsCurveEdit(
  layer: string,
  points: readonly (readonly [number, number])[],
  closed: boolean,
): CanvasEdit {
  return curveEdit(
    layer,
    points.map((p) => ({ x: p[0], y: p[1] })),
    closed,
  );
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
  /** Erased entities are not picked. */
  erased: ReadonlySet<number> = new Set(),
  /** Curves with new points (set_curve, ADR-051) are picked by those points. */
  curveOf: DrawingPreview['curveOf'] = new Map(),
): number[] {
  const minX = Math.min(band.x0, band.x1);
  const maxX = Math.max(band.x0, band.x1);
  const minY = Math.min(band.y0, band.y1);
  const maxY = Math.max(band.y0, band.y1);
  const crossing = isCrossing(band);
  const out: number[] = [];
  const count = scene.view.entities.length;
  for (let index = 0; index < count; index++) {
    if (erased.has(index)) continue;
    const replaced = curveOf.get(index);
    const drawn = replaced ? pointsBox(replaced.points) : tightBox(scene, index);
    if (drawn === null) continue;
    const moved = replaced ? undefined : transformOf.get(index);
    const box = moved ? boxThrough(moved, drawn) : drawn;
    const inside = box.minX >= minX && box.maxX <= maxX && box.minY >= minY && box.maxY <= maxY;
    const touches = box.maxX >= minX && box.minX <= maxX && box.maxY >= minY && box.minY <= maxY;
    if ((crossing ? touches : inside) && isShown(index)) out.push(index);
  }
  return out;
}

function pointsBox(points: readonly (readonly [number, number])[]): Bounds {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
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
  textHeight = 2.5,
): DrawingPreview {
  return applyInputs(scene, preview, edits, textHeight);
}
