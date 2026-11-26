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
import {
  compose,
  IDENTITY,
  mirrorAcross,
  rotationAbout,
  scaleAbout,
  translation,
  type Affine,
} from './affine';
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
  copies: readonly { index: number; transform: Affine; layer?: number }[];
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
}

export const EMPTY_PREVIEW: DrawingPreview = {
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
  const active = corrections
    .filter((item) => item.withdrawnAt === null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((item) => item.correction);
  return applyInputs(scene, EMPTY_PREVIEW, active, textHeight);
}

/** `base` with more corrections applied on top, in order (saved ones, then unsaved edits). */
export function applyInputs(
  scene: DrawingScene,
  base: DrawingPreview,
  inputs: readonly DrawingCorrectionInput[],
  textHeight: number,
): DrawingPreview {
  if (inputs.length === 0) return base;
  const layerOf = new Map(base.layerOf);
  const textOf = new Map(base.textOf);
  let extraTexts = [...base.extraTexts];
  let extraItems = [...base.extraItems];
  let extraCurves = [...base.extraCurves];
  const merged = new Set(base.merged);
  const transformOf = new Map(base.transformOf);
  const erased = new Set(base.erased);
  const copies = [...base.copies];
  const aliases = new Map(base.aliases);
  const curveOf = new Map(base.curveOf);
  let notes = [...base.notes];
  const styleOf = new Map(base.styleOf);
  let shapes = [...base.shapes];
  const orderOf = new Map(base.orderOf);
  const groups = new Map(base.groups);
  const attrOf = new Map(base.attrOf);
  const textFormatOf = new Map(base.textFormatOf);
  let tables = [...base.tables];
  const layers = scene.view.layers;
  const layerIndex = (name: string) =>
    scene.layerByName.get(name) ?? scene.layerByName.get(aliases.get(name) ?? '') ?? -1;
  const colorOf = (index: number) => layers[index]?.color ?? FALLBACK_COLOR;
  const indexes = (handle: string) => scene.byHandle.get(handle) ?? [];
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

  for (const correction of inputs) {
    const step = stepOfInput(correction);
    if (step) {
      for (const index of indexes('handle' in correction ? correction.handle : '')) {
        transformOf.set(index, compose(transformOf.get(index) ?? IDENTITY, step));
      }
      continue;
    }
    switch (correction.kind) {
      case 'move_layer': {
        const target = layerIndex(correction.toLayer);
        if (target < 0) break;
        for (const index of indexes(correction.handle)) layerOf.set(index, target);
        break;
      }
      case 'set_text':
        for (const index of indexes(correction.handle)) textOf.set(index, correction.text);
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
          layerName: correction.layer,
        });
        break;
      }
      case 'add_item': {
        const layer = layerIndex(correction.layer);
        extraItems.push({
          x: correction.x,
          y: correction.y,
          layer,
          color: colorOf(layer),
          layerName: correction.layer,
        });
        break;
      }
      case 'merge_routes':
        for (const handle of correction.handles) {
          for (const index of indexes(handle)) merged.add(index);
        }
        break;
      case 'erase_item':
        for (const index of indexes(correction.handle)) erased.add(index);
        break;
      case 'copy_item': {
        const shift = translation(correction.dx, correction.dy);
        const layer = correction.toLayer === null ? undefined : layerIndex(correction.toLayer);
        for (const index of indexes(correction.handle)) {
          copies.push({
            index,
            transform: compose(transformOf.get(index) ?? IDENTITY, shift),
            ...(layer === undefined ? {} : { layer }),
          });
        }
        break;
      }
      case 'merge_layer': {
        // Every item of `from` goes to `to`; the target keeps its own colour and rule.
        const target = layerIndex(correction.to);
        for (const index of onLayer(correction.from)) layerOf.set(index, target);
        const move = <T extends { layerName: string; layer: number }>(item: T): T =>
          item.layerName === correction.from
            ? { ...item, layerName: correction.to, layer: target }
            : item;
        extraTexts = extraTexts.map(move);
        extraItems = extraItems.map(move);
        extraCurves = extraCurves.map(move);
        notes = notes.map(move);
        shapes = shapes.map(move);
        tables = tables.map(move);
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
        extraCurves.push({
          path: correction.points.flat(),
          closed: correction.closed,
          layer,
          color: colorOf(layer),
          layerName: correction.layer,
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
        const rename = <T extends { layerName: string }>(item: T): T =>
          item.layerName === correction.from ? { ...item, layerName: correction.to } : item;
        extraTexts = extraTexts.map(rename);
        extraItems = extraItems.map(rename);
        extraCurves = extraCurves.map(rename);
        notes = notes.map(rename);
        shapes = shapes.map(rename);
        tables = tables.map(rename);
        break;
      }
      case 'delete_layer': {
        for (const index of onLayer(correction.layer)) erased.add(index);
        const keep = (item: { layerName: string }) => item.layerName !== correction.layer;
        extraTexts = extraTexts.filter(keep);
        extraItems = extraItems.filter(keep);
        extraCurves = extraCurves.filter(keep);
        notes = notes.filter(keep);
        shapes = shapes.filter(keep);
        tables = tables.filter(keep);
        break;
      }
      case 'set_curve':
        // New points replace the curve; moves made before are already in them.
        for (const index of indexes(correction.handle)) {
          curveOf.set(index, { points: correction.points, closed: correction.closed });
          transformOf.delete(index);
        }
        break;
      case 'add_note': {
        const layer = layerIndex(correction.layer);
        notes.push({
          note: correction.note,
          points: correction.points,
          text: correction.text,
          layer,
          color: colorOf(layer),
          layerName: correction.layer,
        });
        break;
      }
      case 'set_style':
        for (const index of indexes(correction.handle)) {
          styleOf.set(index, {
            color: correction.color,
            linetype: correction.linetype,
            lineweight: correction.lineweight,
          });
        }
        break;
      case 'add_shape': {
        const layer = layerIndex(correction.layer);
        shapes.push({
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
        });
        break;
      }
      case 'set_order':
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
        tables.push({
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
        });
        break;
      }
      case 'dismiss_problem':
        break; // changes nothing on the drawing (ADR-046)
    }
  }
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
  };
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
  return preview.layerOf.get(index) ?? (scene.view.entities[index]?.layer as number);
}
