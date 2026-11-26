import {
  NEW_HANDLE_PREFIX,
  type CreateDrawingCorrectionRequest,
  type DrawingCorrectionInput,
} from '@ftth/shared';
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

/** Edits that add an item to the page (an object a later edit may name, ADR-061). */
const ADDING = new Set<CanvasEdit['kind']>([
  'add_curve',
  'add_text',
  'add_item',
  'add_note',
  'add_shape',
  'add_table',
  'copy_item',
]);

export const addsItem = (edit: CanvasEdit): boolean => ADDING.has(edit.kind);

/**
 * The client's name of the item an unsaved edit adds (ADR-061): kept with the edit object itself
 * (Undo / Redo bring the same objects back), so its page row keeps the handle `NEW-<ref>` until
 * «حفظ», which sends the add with this `ref`.
 */
const refs = new WeakMap<CanvasEdit, string>();
const REF_PREFIX = `w${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
let refCount = 0;

/** The ref of an edit that adds an item (made the first time it is asked); null otherwise. */
export function editRef(edit: CanvasEdit): string | null {
  if (!addsItem(edit)) return null;
  let ref = refs.get(edit);
  if (ref === undefined) {
    refCount += 1;
    ref = `${REF_PREFIX}${refCount.toString(36)}`;
    refs.set(edit, ref);
  }
  return ref;
}

/** The handle the item an unsaved edit adds has on the page (`NEW-<ref>`), or undefined. */
export function editHandle(edit: CanvasEdit): string | undefined {
  const ref = editRef(edit);
  return ref === null ? undefined : `${NEW_HANDLE_PREFIX}${ref}`;
}

/**
 * The edits as correction requests, in the order made. An edit that adds an item carries its
 * `ref`, so a later request of the same save may name the item `NEW-<ref>` (ADR-061).
 */
export function editRequests(edits: readonly CanvasEdit[]): CreateDrawingCorrectionRequest[] {
  return edits.map((edit) => {
    const ref = editRef(edit);
    return { correction: { ...edit }, problem: null, ...(ref === null ? {} : { ref }) };
  });
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

export function copyEdits(
  handles: readonly string[],
  dx: number,
  dy: number,
  toLayer: string | null = null,
): CanvasEdit[] {
  return handles.map((handle) => ({ kind: 'copy_item', handle, dx: r(dx), dy: r(dy), toLayer }));
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

/** CIRCLE drawn on the page: a true circle (add_curve.arc, ADR-061) with its outline points. */
export function circleCurveEdit(
  layer: string,
  center: readonly [number, number],
  radius: number,
  outline: readonly (readonly [number, number])[],
): CanvasEdit {
  const edit = pointsCurveEdit(layer, outline, true);
  if (edit.kind !== 'add_curve' || !(radius > 0)) return edit;
  return { ...edit, arc: { x: r(center[0]), y: r(center[1]), r: r(radius), start: 0, end: 360 } };
}

/**
 * The true arc through drawn arc points (first, middle, last), counter-clockwise from `start` to
 * `end` degrees as AutoCAD keeps arcs; null when the points are in a line.
 */
export function arcOfPoints(
  points: readonly (readonly [number, number])[],
): { x: number; y: number; r: number; start: number; end: number } | null {
  const a = points[0];
  const m = points[Math.floor(points.length / 2)];
  const b = points[points.length - 1];
  if (!a || !m || !b || points.length < 3) return null;
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sq = (p: readonly [number, number]) => p[0] * p[0] + p[1] * p[1];
  const x = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const y = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const deg = (p: readonly [number, number]) => {
    const out = ((((Math.atan2(p[1] - y, p[0] - x) * 180) / Math.PI) % 360) + 360) % 360;
    return Math.abs(out - 360) < 1e-9 ? 0 : out;
  };
  // The turn first → middle → last: counter-clockwise keeps the order, clockwise swaps the ends.
  const ccw = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]) > 0;
  const start = deg(ccw ? a : b);
  let end = deg(ccw ? b : a);
  if (end <= start) end += 360;
  return { x: r(x), y: r(y), r: r(Math.hypot(a[0] - x, a[1] - y)), start: r(start), end: r(end) };
}

/** ARC drawn on the page: a true arc (add_curve.arc, ADR-061) with its points. */
export function arcCurveEdit(
  layer: string,
  points: readonly (readonly [number, number])[],
): CanvasEdit {
  const edit = pointsCurveEdit(layer, points, false);
  const arc = arcOfPoints(points);
  return edit.kind === 'add_curve' && arc ? { ...edit, arc } : edit;
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

/**
 * The saved corrections' preview with the unsaved edits drawn on top; the first `named` edits
 * give their items `NEW-<ref>` handles (the rest are a command's preview, not yet kept).
 */
export function previewWithEdits(
  scene: DrawingScene,
  preview: DrawingPreview,
  edits: readonly CanvasEdit[],
  textHeight = 2.5,
  named = edits.length,
): DrawingPreview {
  return applyInputs(
    scene,
    preview,
    edits,
    textHeight,
    edits.map((edit, i) => (i < named ? editHandle(edit) : undefined)),
  );
}
