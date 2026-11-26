import type {
  DrawingCorrection,
  DrawingCorrectionInput,
  DrawingLinetype,
  DrawingNoteKind,
  DrawingShapeKind,
  HatchDrawOrder,
  HatchIslandStyle,
  HatchPattern,
  TableCellStyle,
} from '@ftth/shared';
import { fixHandle } from '@ftth/shared';
import {
  angleOf,
  applyAffine,
  compose,
  IDENTITY,
  mirrorAcross,
  rotationAbout,
  scaleAbout,
  scaleOf,
  translation,
  type Affine,
} from './affine';
import { fileSceneOf, type DrawingScene } from './drawing-scene';

/** Colour of a preview shape whose layer is not in the drawing view. */
export const FALLBACK_COLOR = '#333333';

export interface PreviewText {
  x: number;
  y: number;
  height: number;
  text: string;
  /** Degrees counter-clockwise, once turned by ROTATE (absent = 0). */
  rotation?: number;
  /** Index into the view's layers; -1 when the layer is not in the view (always shown). */
  layer: number;
  color: string;
  /** Layer name (a deleted or renamed layer is matched by name). */
  layerName: string;
}

export interface PreviewItem {
  x: number;
  y: number;
  layer: number;
  color: string;
  layerName: string;
}

/** A line or polyline drawn on the page (add_curve, ADR-050), flat [x0, y0, x1, y1, …]. */
export interface PreviewCurve {
  path: readonly number[];
  closed: boolean;
  layer: number;
  color: string;
  layerName: string;
  /** A true circle / arc (add_curve.arc, ADR-061); `path` is its flattened outline. */
  arc?: PreviewArc;
}

/** Centre, radius, counter-clockwise from `start` to `end` degrees (0 → 360: a circle). */
export interface PreviewArc {
  x: number;
  y: number;
  r: number;
  start: number;
  end: number;
}

/** A copy of an entity of the file (copy_item; ADR-050), drawn with its own transform. */
export interface PreviewCopy {
  index: number;
  transform: Affine;
  layer?: number;
}

/** What one item drawn, pasted or copied on the page is (ADR-061). */
export type PageItemValue =
  | { type: 'curve'; value: PreviewCurve }
  | { type: 'text'; value: PreviewText }
  | { type: 'point'; value: PreviewItem }
  | { type: 'note'; value: PreviewNote }
  | { type: 'shape'; value: PreviewShape }
  | { type: 'table'; value: PreviewTable }
  | { type: 'copy'; value: PreviewCopy };

/**
 * An item drawn, pasted or copied on the page, an object like the file's (ADR-061, owner item
 * 36): `FIX-<correction id>` once saved, `NEW-<ref>` before («حفظ» sends its add with `ref`).
 * Items keep their place in the list when erased, so the page rows keep their indexes.
 */
export interface PageItem {
  /** '' when nothing can name it (a command's preview before it is kept). */
  handle: string;
  item: PageItemValue;
  erased: boolean;
  /** Its latest set_style (null = by layer). */
  style: PreviewStyle | null;
  /** Its latest set_order (null = unset). */
  order: number | null;
}

/** A dimension or leader drawn on the page (add_note, ADR-051): screen only. */
export interface PreviewNote {
  note: DrawingNoteKind;
  points: readonly (readonly [number, number])[];
  text: string | null;
  layer: number;
  color: string;
  layerName: string;
}

/** A hatch, gradient, wipeout, donut, XLINE or RAY drawn on the page (add_shape): screen only. */
export interface PreviewShape {
  shape: DrawingShapeKind;
  points: readonly (readonly [number, number])[];
  pattern: HatchPattern | null;
  scale: number;
  angle: number;
  /** Its own colour, null = the layer's. */
  color: string | null;
  color2: string | null;
  inner: number | null;
  outer: number | null;
  /** More loops of a hatch or gradient (islands, several picks; ADR-055 part 8). */
  loops: readonly (readonly (readonly [number, number])[])[];
  island: HatchIslandStyle;
  background: string | null;
  /** 0-90 %. */
  transparency: number;
  origin: readonly [number, number] | null;
  double: boolean;
  drawOrder: HatchDrawOrder;
  layer: number;
  /** The layer's colour (`color` null). */
  layerColor: string;
  layerName: string;
}

/** How a text of the drawing looks (set_text_format; ADR-055 part 7). Screen only. */
export interface PreviewTextFormat {
  widthFactor: number | null;
  mtext: boolean;
  wrap: number | null;
  mask: { offset: number; color: string | null } | null;
}

/** A table drawn on the page (add_table; owner 2026-11-26). Screen only. */
export interface PreviewTable {
  x: number;
  y: number;
  columns: readonly number[];
  rows: readonly number[];
  height: number;
  styles: readonly [TableCellStyle, TableCellStyle, TableCellStyle];
  cells: readonly (readonly string[])[];
  layer: number;
  color: string;
  layerName: string;
}

/** How an entity is drawn (set_style, ADR-051); null = by layer. Screen only. */
export interface PreviewStyle {
  color: string | null;
  linetype: DrawingLinetype | null;
  lineweight: number | null;
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
  /**
   * Entity → how it was moved / turned / mirrored / scaled (ADR-047, ADR-050), drawn there.
   */
  transformOf: ReadonlyMap<number, Affine>;
  /** Entities erased (erase_item, delete_layer; ADR-050): not drawn, not picked. */
  erased: ReadonlySet<number>;
  /** Copies of entities (copy_item; ADR-050), drawn with their own transform (and layer). */
  copies: readonly PreviewCopy[];
  /** Lines and polylines drawn on the page (add_curve; ADR-050). */
  extraCurves: readonly PreviewCurve[];
  /** Layer added or renamed on the page → the view layer whose colour it takes (ADR-050). */
  aliases: ReadonlyMap<string, string>;
  /**
   * Entity → its new points in drawing units (set_curve: Trim, Fillet, Stretch; ADR-051), drawn
   * instead of its own path, after which `transformOf` moves it.
   */
  curveOf: ReadonlyMap<number, { points: readonly (readonly [number, number])[]; closed: boolean }>;
  /** Dimensions and leaders (add_note; ADR-051). */
  notes: readonly PreviewNote[];
  /** Entity → its latest style (set_style; ADR-051). */
  styleOf: ReadonlyMap<number, PreviewStyle>;
  /** Shapes drawn on the page (add_shape; owner 2026-11-24). */
  shapes: readonly PreviewShape[];
  /** Entity → its draw order (set_order): drawn lowest first, 0 when unset. */
  orderOf: ReadonlyMap<number, number>;
  /** Groups and page blocks by name (set_group; owner 2026-11-24): their members' handles. */
  groups: ReadonlyMap<string, { handles: readonly string[]; block: boolean }>;
  /** Insert → its attribute values changed (set_attribute): old value → new value. */
  attrOf: ReadonlyMap<number, ReadonlyMap<string, string>>;
  /** Text → its latest format (set_text_format: TEXTFIT, TXT2MTXT, TEXTMASK). */
  textFormatOf: ReadonlyMap<number, PreviewTextFormat>;
  /** Tables drawn on the page (add_table). */
  tables: readonly PreviewTable[];
  /**
   * Every item drawn, pasted or copied on the page, in the order made (ADR-061). Page row `k` has
   * the index `fileCount + k` in the page scene; `erased` holds the erased ones' indexes too.
   * The lists above (`extraCurves`, `copies`, …) are the live ones, as drawn.
   */
  page: readonly PageItem[];
  /** How many entities the file's view has (page rows come after them). */
  fileCount: number;
}

export const EMPTY_PREVIEW: DrawingPreview = {
  page: [],
  fileCount: 0,
  layerOf: new Map(),
  textOf: new Map(),
  extraTexts: [],
  extraItems: [],
  merged: new Set(),
  transformOf: new Map(),
  erased: new Set(),
  copies: [],
  extraCurves: [],
  aliases: new Map(),
  curveOf: new Map(),
  notes: [],
  styleOf: new Map(),
  shapes: [],
  orderOf: new Map(),
  groups: new Map(),
  attrOf: new Map(),
  textFormatOf: new Map(),
  tables: [],
};

/** Text height of an added label that has none: 0.25 m, or 2.5 drawing units without a scale. */
export function defaultTextHeight(metresPerUnit: number | null): number {
  if (metresPerUnit === null || !(metresPerUnit > 0)) return 2.5;
  return 0.25 / metresPerUnit;
}

/** The move / turn / mirror / scale a correction makes, or null when it moves nothing. */
export function stepOfInput(input: DrawingCorrectionInput): Affine | null {
  switch (input.kind) {
    case 'move_item':
      return translation(input.dx, input.dy);
    case 'rotate_item':
      return rotationAbout(input.x, input.y, input.angle);
    case 'mirror_item':
      return mirrorAcross(input.x1, input.y1, input.x2, input.y2);
    case 'scale_item':
      return scaleAbout(input.x, input.y, input.factor);
    default:
      return null;
  }
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
  // The API's order (created_at, then id): the order the build applies them in.
  const active = corrections
    .filter((item) => item.withdrawnAt === null)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return applyInputs(
    scene,
    EMPTY_PREVIEW,
    active.map((item) => item.correction),
    textHeight,
    active.map((item) => fixHandle(item.id)),
  );
}

/** The handle each live page item has, for the rows of the page scene. */
export function pageHandles(preview: DrawingPreview): Map<string, number[]> {
  const out = new Map<string, number[]>();
  preview.page.forEach((entry, k) => {
    if (!entry.handle) return;
    const list = out.get(entry.handle);
    if (list) list.push(k);
    else out.set(entry.handle, [k]);
  });
  return out;
}

const normalDegrees = (degrees: number) => {
  const out = ((degrees % 360) + 360) % 360;
  return Math.abs(out - 360) < 1e-9 ? 0 : out;
};

/** A circle / arc moved, turned, mirrored or scaled (a mirror runs it the other way round). */
export function transformArc(arc: PreviewArc, t: Affine): PreviewArc {
  const c = applyAffine(t, arc.x, arc.y);
  const r = arc.r * scaleOf(t);
  if (arc.end - arc.start >= 360 - 1e-9) return { x: c.x, y: c.y, r, start: 0, end: 360 };
  const at = (degrees: number) => {
    const rad = (degrees * Math.PI) / 180;
    const p = applyAffine(t, arc.x + arc.r * Math.cos(rad), arc.y + arc.r * Math.sin(rad));
    return normalDegrees((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
  };
  const mirrored = t[0] * t[3] - t[1] * t[2] < 0;
  const start = at(mirrored ? arc.end : arc.start);
  let end = at(mirrored ? arc.start : arc.end);
  if (end <= start) end += 360;
  return { x: c.x, y: c.y, r, start, end };
}

const mapPoint = (t: Affine, p: readonly [number, number]): [number, number] => {
  const q = applyAffine(t, p[0], p[1]);
  return [q.x, q.y];
};

/** A page item where a move / turn / mirror / scale puts it (texts stay readable: MIRRTEXT 0). */
export function transformPageItem(item: PageItemValue, t: Affine): PageItemValue {
  const s = scaleOf(t);
  const mirrored = t[0] * t[3] - t[1] * t[2] < 0;
  switch (item.type) {
    case 'curve': {
      const path: number[] = [];
      const flat = item.value.path;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const q = applyAffine(t, flat[i] as number, flat[i + 1] as number);
        path.push(q.x, q.y);
      }
      const { arc, ...rest } = item.value;
      return {
        type: 'curve',
        value: arc ? { ...rest, path, arc: transformArc(arc, t) } : { ...rest, path },
      };
    }
    case 'text': {
      const q = applyAffine(t, item.value.x, item.value.y);
      const rotation = normalDegrees((item.value.rotation ?? 0) + (mirrored ? 0 : angleOf(t)));
      return {
        type: 'text',
        value: {
          ...item.value,
          x: q.x,
          y: q.y,
          height: item.value.height * s,
          ...(rotation === 0 && item.value.rotation === undefined ? {} : { rotation }),
        },
      };
    }
    case 'point': {
      const q = applyAffine(t, item.value.x, item.value.y);
      return { type: 'point', value: { ...item.value, x: q.x, y: q.y } };
    }
    case 'note':
      return {
        type: 'note',
        value: { ...item.value, points: item.value.points.map((p) => mapPoint(t, p)) },
      };
    case 'shape': {
      const v = item.value;
      return {
        type: 'shape',
        value: {
          ...v,
          points: v.points.map((p) => mapPoint(t, p)),
          loops: v.loops.map((loop) => loop.map((p) => mapPoint(t, p))),
          origin: v.origin ? mapPoint(t, v.origin) : null,
          inner: v.inner === null ? null : v.inner * s,
          outer: v.outer === null ? null : v.outer * s,
          scale: v.pattern === 'SOLID' ? v.scale : v.scale * s,
          angle: mirrored ? v.angle : normalDegrees(v.angle + angleOf(t)),
        },
      };
    }
    case 'table': {
      // A table keeps its upright cells (the web draws no turned table): its corner moves.
      const q = applyAffine(t, item.value.x, item.value.y);
      return {
        type: 'table',
        value: {
          ...item.value,
          x: q.x,
          y: q.y,
          columns: item.value.columns.map((w) => w * s),
          rows: item.value.rows.map((h) => h * s),
          height: item.value.height * s,
        },
      };
    }
    case 'copy':
      return {
        type: 'copy',
        value: { ...item.value, transform: compose(item.value.transform, t) },
      };
  }
}

/** `base` with more corrections applied on top, in order (saved ones, then unsaved edits). */
export function applyInputs(
  sceneIn: DrawingScene,
  base: DrawingPreview,
  inputs: readonly DrawingCorrectionInput[],
  textHeight: number,
  /**
   * The handle of the item each input adds (ADR-061): `FIX-<id>` for saved ones, `NEW-<ref>` for
   * unsaved ones; absent or '' = an item nothing can name.
   */
  handles: readonly (string | undefined)[] = [],
): DrawingPreview {
  if (inputs.length === 0) return base;
  const scene = fileSceneOf(sceneIn);
  const fileCount = scene.view.entities.length;
  const layerOf = new Map(base.layerOf);
  const textOf = new Map(base.textOf);
  const merged = new Set(base.merged);
  const transformOf = new Map(base.transformOf);
  const erased = new Set(base.erased);
  const aliases = new Map(base.aliases);
  const curveOf = new Map(base.curveOf);
  const styleOf = new Map(base.styleOf);
  const orderOf = new Map(base.orderOf);
  const groups = new Map(base.groups);
  const attrOf = new Map(base.attrOf);
  const textFormatOf = new Map(base.textFormatOf);
  const page: PageItem[] = [...base.page];
  const pageAt = pageHandles(base);
  const layers = scene.view.layers;
  const layerIndex = (name: string) =>
    scene.layerByName.get(name) ?? scene.layerByName.get(aliases.get(name) ?? '') ?? -1;
  const colorOf = (index: number) => layers[index]?.color ?? FALLBACK_COLOR;
  const indexes = (handle: string) => scene.byHandle.get(handle) ?? [];
  /** The live page items a handle names (FIX- / NEW- handles). */
  const own = (handle: string): number[] =>
    (pageAt.get(handle) ?? []).filter((k) => !(page[k] as PageItem).erased);
  const change = (k: number, next: Partial<PageItem>) => {
    page[k] = { ...(page[k] as PageItem), ...next };
  };
  const push = (handle: string | undefined, item: PageItemValue, from?: PageItem) => {
    const k = page.length;
    page.push({
      handle: handle ?? '',
      item,
      erased: false,
      style: from?.style ?? null,
      order: from?.order ?? null,
    });
    if (handle) {
      const list = pageAt.get(handle);
      if (list) list.push(k);
      else pageAt.set(handle, [k]);
    }
  };
  /** The layer (index) and its name of a copy of a file entity. */
  const copyLayer = (copy: PreviewCopy) => {
    const layer =
      copy.layer ?? layerOf.get(copy.index) ?? scene.view.entities[copy.index]?.layer ?? -1;
    return { layer, name: layers[layer]?.name ?? '' };
  };
  /** Every live page item's layer name passed through `rename`, with its layer index again. */
  const relayer = (rename: (name: string) => string | null) => {
    page.forEach((entry, k) => {
      if (entry.erased) return;
      if (entry.item.type === 'copy') {
        const now = copyLayer(entry.item.value);
        const to = rename(now.name);
        if (to === null) return;
        change(k, {
          item: { type: 'copy', value: { ...entry.item.value, layer: layerIndex(to) } },
        });
        return;
      }
      const v = entry.item.value;
      const to = rename(v.layerName);
      if (to === null) return;
      const layer = layerIndex(to);
      change(k, { item: withLayer(entry.item, to, layer, colorOf(layer)) });
    });
  };
  /** Entities whose layer (after earlier moves) is `name`. */
  const onLayer = (name: string) => {
    const target = layerIndex(name);
    const out: number[] = [];
    if (target < 0) return out;
    scene.view.entities.forEach((entity, index) => {
      if ((layerOf.get(index) ?? entity.layer) === target && !erased.has(index)) out.push(index);
    });
    return out;
  };

  inputs.forEach((correction, at) => {
    const adds = handles[at] || undefined;
    const step = stepOfInput(correction);
    if (step) {
      const handle = 'handle' in correction ? correction.handle : '';
      for (const k of own(handle)) {
        change(k, { item: transformPageItem((page[k] as PageItem).item, step) });
      }
      for (const index of indexes(handle)) {
        transformOf.set(index, compose(transformOf.get(index) ?? IDENTITY, step));
      }
      return;
    }
    switch (correction.kind) {
      case 'move_layer': {
        const target = layerIndex(correction.toLayer);
        for (const k of own(correction.handle)) {
          const entry = page[k] as PageItem;
          change(k, {
            item:
              entry.item.type === 'copy'
                ? { type: 'copy', value: { ...entry.item.value, layer: target } }
                : withLayer(entry.item, correction.toLayer, target, colorOf(target)),
          });
        }
        if (target < 0) break;
        for (const index of indexes(correction.handle)) layerOf.set(index, target);
        break;
      }
      case 'set_text':
        for (const k of own(correction.handle)) {
          const entry = page[k] as PageItem;
          if (entry.item.type === 'text') {
            change(k, {
              item: { type: 'text', value: { ...entry.item.value, text: correction.text } },
            });
          }
        }
        for (const index of indexes(correction.handle)) textOf.set(index, correction.text);
        break;
      case 'add_text': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'text',
          value: {
            x: correction.x,
            y: correction.y,
            height: correction.height ?? textHeight,
            text: correction.text,
            layer,
            color: colorOf(layer),
            layerName: correction.layer,
          },
        });
        break;
      }
      case 'add_item': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'point',
          value: {
            x: correction.x,
            y: correction.y,
            layer,
            color: colorOf(layer),
            layerName: correction.layer,
          },
        });
        break;
      }
      case 'merge_routes':
        for (const handle of correction.handles) {
          for (const index of indexes(handle)) merged.add(index);
        }
        break;
      case 'erase_item':
        for (const k of own(correction.handle)) change(k, { erased: true });
        for (const index of indexes(correction.handle)) erased.add(index);
        break;
      case 'copy_item': {
        const shift = translation(correction.dx, correction.dy);
        const layer = correction.toLayer === null ? undefined : layerIndex(correction.toLayer);
        // A copy of an item of the page is an item of its own, of the same kind (ADR-061).
        for (const k of own(correction.handle)) {
          const from = page[k] as PageItem;
          let item = transformPageItem(from.item, shift);
          if (correction.toLayer !== null && layer !== undefined) {
            item =
              item.type === 'copy'
                ? { type: 'copy', value: { ...item.value, layer } }
                : withLayer(item, correction.toLayer, layer, colorOf(layer));
          }
          push(adds, item, from);
        }
        for (const index of indexes(correction.handle)) {
          push(adds, {
            type: 'copy',
            value: {
              index,
              transform: compose(transformOf.get(index) ?? IDENTITY, shift),
              ...(layer === undefined ? {} : { layer }),
            },
          });
        }
        break;
      }
      case 'merge_layer': {
        // Every item of `from` goes to `to`; the target keeps its own colour and rule.
        const target = layerIndex(correction.to);
        for (const index of onLayer(correction.from)) layerOf.set(index, target);
        relayer((name) => (name === correction.from ? correction.to : null));
        break;
      }
      case 'set_group':
        if (correction.handles.length === 0) groups.delete(correction.name);
        else {
          groups.set(correction.name, { handles: correction.handles, block: correction.block });
        }
        break;
      case 'set_attribute':
        for (const index of indexes(correction.handle)) {
          const changed = new Map(attrOf.get(index));
          // A value changed again keeps pointing at the file's value.
          const original = [...changed].find(([, to]) => to === correction.from)?.[0];
          changed.set(original ?? correction.from, correction.to);
          attrOf.set(index, changed);
        }
        break;
      case 'add_curve': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'curve',
          value: {
            path: correction.points.flat(),
            closed: correction.closed,
            layer,
            color: colorOf(layer),
            layerName: correction.layer,
            ...(correction.arc ? { arc: { ...correction.arc } } : {}),
          },
        });
        break;
      }
      case 'add_layer':
        // A layer for drawing only (like null) is known by its own name (ADR-051).
        aliases.set(
          correction.layer,
          correction.like === null
            ? correction.layer
            : (aliases.get(correction.like) ?? correction.like),
        );
        break;
      case 'rename_layer': {
        const moved = onLayer(correction.from);
        aliases.set(correction.to, aliases.get(correction.from) ?? correction.from);
        const target = layerIndex(correction.to);
        for (const index of moved) layerOf.set(index, target);
        relayer((name) => (name === correction.from ? correction.to : null));
        break;
      }
      case 'delete_layer': {
        for (const index of onLayer(correction.layer)) erased.add(index);
        page.forEach((entry, k) => {
          if (entry.erased) return;
          const name =
            entry.item.type === 'copy'
              ? copyLayer(entry.item.value).name
              : entry.item.value.layerName;
          if (name === correction.layer) change(k, { erased: true });
        });
        break;
      }
      case 'set_curve':
        for (const k of own(correction.handle)) {
          const entry = page[k] as PageItem;
          const path = correction.points.flat();
          if (entry.item.type === 'curve') {
            // New points replace the curve (a trimmed circle is a polyline on the screen).
            const rest = { ...entry.item.value };
            delete rest.arc;
            change(k, {
              item: { type: 'curve', value: { ...rest, path, closed: correction.closed } },
            });
          } else if (entry.item.type === 'copy') {
            const { layer, name } = copyLayer(entry.item.value);
            change(k, {
              item: {
                type: 'curve',
                value: {
                  path,
                  closed: correction.closed,
                  layer,
                  color: colorOf(layer),
                  layerName: name,
                },
              },
            });
          }
        }
        // New points replace the curve; moves made before are already in them.
        for (const index of indexes(correction.handle)) {
          curveOf.set(index, { points: correction.points, closed: correction.closed });
          transformOf.delete(index);
        }
        break;
      case 'add_note': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'note',
          value: {
            note: correction.note,
            points: correction.points,
            text: correction.text,
            layer,
            color: colorOf(layer),
            layerName: correction.layer,
          },
        });
        break;
      }
      case 'set_style': {
        const style = {
          color: correction.color,
          linetype: correction.linetype,
          lineweight: correction.lineweight,
        };
        for (const k of own(correction.handle)) change(k, { style });
        for (const index of indexes(correction.handle)) styleOf.set(index, style);
        break;
      }
      case 'add_shape': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'shape',
          value: {
            shape: correction.shape,
            points: correction.points,
            pattern: correction.pattern,
            scale: correction.scale,
            angle: correction.angle,
            color: correction.color,
            color2: correction.color2,
            inner: correction.inner,
            outer: correction.outer,
            loops: correction.loops,
            island: correction.island,
            background: correction.background,
            transparency: correction.transparency,
            origin: correction.origin,
            double: correction.double,
            drawOrder: correction.drawOrder,
            layer,
            layerColor: colorOf(layer),
            layerName: correction.layer,
          },
        });
        break;
      }
      case 'set_order':
        for (const k of own(correction.handle)) change(k, { order: correction.order });
        for (const index of indexes(correction.handle)) orderOf.set(index, correction.order);
        break;
      case 'set_text_format':
        for (const index of indexes(correction.handle)) {
          textFormatOf.set(index, {
            widthFactor: correction.widthFactor,
            mtext: correction.mtext,
            wrap: correction.wrap,
            mask: correction.mask,
          });
        }
        break;
      case 'add_table': {
        const layer = layerIndex(correction.layer);
        push(adds, {
          type: 'table',
          value: {
            x: correction.x,
            y: correction.y,
            columns: correction.columns,
            rows: correction.rows,
            height: correction.height,
            styles: correction.styles,
            cells: correction.cells,
            layer,
            color: colorOf(layer),
            layerName: correction.layer,
          },
        });
        break;
      }
      case 'dismiss_problem':
        break; // changes nothing on the drawing (ADR-046)
    }
  });
  // The lists the canvas draws: the live page items, in the order made, in their style.
  const extraTexts: PreviewText[] = [];
  const extraItems: PreviewItem[] = [];
  const extraCurves: PreviewCurve[] = [];
  const notes: PreviewNote[] = [];
  const shapes: PreviewShape[] = [];
  const tables: PreviewTable[] = [];
  const copies: PreviewCopy[] = [];
  page.forEach((entry, k) => {
    if (entry.erased) {
      erased.add(fileCount + k);
      return;
    }
    // Properties, MATCHPROP and the ribbon read a page row's style by its index, as the file's.
    if (entry.style) styleOf.set(fileCount + k, entry.style);
    const color = entry.style?.color ?? null;
    const { item } = entry;
    switch (item.type) {
      case 'curve':
        extraCurves.push(color ? { ...item.value, color } : item.value);
        break;
      case 'text':
        extraTexts.push(color ? { ...item.value, color } : item.value);
        break;
      case 'point':
        extraItems.push(color ? { ...item.value, color } : item.value);
        break;
      case 'note':
        notes.push(color ? { ...item.value, color } : item.value);
        break;
      case 'table':
        tables.push(color ? { ...item.value, color } : item.value);
        break;
      case 'shape':
        shapes.push(color ? { ...item.value, color } : item.value);
        break;
      case 'copy':
        copies.push(item.value);
        break;
    }
  });
  return {
    layerOf,
    textOf,
    extraTexts,
    extraItems,
    merged,
    transformOf,
    erased,
    copies,
    extraCurves,
    aliases,
    curveOf,
    notes,
    styleOf,
    shapes,
    orderOf,
    groups,
    attrOf,
    textFormatOf,
    tables,
    page,
    fileCount,
  };
}

/** The page item with this layer (name, index and the layer's colour). */
function withLayer(item: PageItemValue, name: string, layer: number, color: string): PageItemValue {
  switch (item.type) {
    case 'shape':
      return { type: 'shape', value: { ...item.value, layerName: name, layer, layerColor: color } };
    case 'copy':
      return { type: 'copy', value: { ...item.value, layer } };
    default:
      return { ...item, value: { ...item.value, layerName: name, layer, color } } as PageItemValue;
  }
}

/** The entities of a handle get `step` after what moved them already. */
export function moveEntities(
  scene: DrawingScene,
  transformOf: Map<number, Affine>,
  handle: string,
  step: Affine,
): void {
  for (const index of scene.byHandle.get(handle) ?? []) {
    transformOf.set(index, compose(transformOf.get(index) ?? IDENTITY, step));
  }
}

/** Layer an entity is on now: the correction's target, else its own. */
export function effectiveLayer(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): number {
  const moved = preview.layerOf.get(index);
  if (moved !== undefined) return moved;
  const entity = scene.view.entities[index];
  if (entity) return entity.layer;
  // An item of the page asked of the file's scene: its own layer (-1: not in the view).
  const item = preview.page[index - preview.fileCount];
  if (!item) return -1;
  if (item.item.type !== 'copy') return item.item.value.layer;
  const copy = item.item.value;
  return (
    copy.layer ?? preview.layerOf.get(copy.index) ?? scene.view.entities[copy.index]?.layer ?? -1
  );
}
