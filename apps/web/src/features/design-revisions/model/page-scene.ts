import type { DrawingViewEntity, DrawingViewLayer } from '@ftth/shared';
import { angleOf, applyAffine, scaleOf } from './affine';
import {
  FALLBACK_COLOR,
  type DrawingPreview,
  type PageItem,
  type PreviewArc,
} from './drawing-preview';
import { entityBox, type DrawingScene } from './drawing-scene';
import { EntityGrid, entityGridOf, setEntityGrid, type Box, type SpatialIndex } from './entity-grid';
import { linearDimension } from './geometry';
import { cellRects } from './table';

/**
 * Items drawn, pasted or copied on the page are objects like the file's (ADR-061, owner item 36):
 * each live page item of the preview becomes a row shaped like a `DrawingViewEntity` (LINE,
 * LWPOLYLINE, CIRCLE, ARC, TEXT, POINT, HATCH, DIMENSION, LEADER, ACAD_TABLE… or the copied
 * entity's own kind), appended after the file's entities in a page scene. The page scene has the
 * file's entities with the same indexes, its boxes plus the rows' boxes, a spatial index of the
 * file plus one of the rows, `byHandle` with the rows' FIX- / NEW- handles and `layerByName` with
 * the layers made on the page, so picking, windows, grips, snaps, Properties and every Modify
 * command see page items exactly as file objects. The rows' geometry is where the item is drawn
 * now (the preview moves page items themselves), so no transform of the preview applies to them.
 */

/** A page row: a page item as an entity of the view. */
export interface PageRow extends DrawingViewEntity {
  /** Its place in `preview.page`. */
  pageItem: number;
  /** A true circle / arc (add_curve.arc). */
  arc?: PreviewArc;
  /** Points a Node snap finds (a point, a dimension's definition points). */
  nodes?: readonly (readonly [number, number])[];
}

export const isPageRow = (entity: DrawingViewEntity | undefined): entity is PageRow =>
  entity !== undefined && typeof (entity as Partial<PageRow>).pageItem === 'number';

/** Segments of a circle / arc outline drawn by the row (the path the canvas strokes). */
const ARC_SEGMENTS = 64;

function arcPath(arc: PreviewArc): number[] {
  const sweep = Math.min(360, arc.end - arc.start);
  const steps = Math.max(2, Math.ceil((sweep / 360) * ARC_SEGMENTS));
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((arc.start + (sweep * i) / steps) * Math.PI) / 180;
    out.push(arc.x + arc.r * Math.cos(a), arc.y + arc.r * Math.sin(a));
  }
  return out;
}

const closedFlat = (points: readonly (readonly [number, number])[]): number[] => {
  const out = points.flatMap((p) => [p[0], p[1]]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && points.length > 2 && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push(first[0], first[1]);
  }
  return out;
};

/** A path of at least two points (a single point is a zero-length segment). */
const atLeastTwo = (flat: number[]): number[] =>
  flat.length >= 4 ? flat : flat.length === 2 ? [...flat, ...flat] : [];

/** The kind AutoCAD gives a page item (DXF type). */
export function pageItemKind(file: DrawingScene, entry: PageItem): string {
  const { item } = entry;
  switch (item.type) {
    case 'curve': {
      const v = item.value;
      if (v.arc) return v.arc.end - v.arc.start >= 360 - 1e-9 ? 'CIRCLE' : 'ARC';
      return !v.closed && v.path.length === 4 ? 'LINE' : 'LWPOLYLINE';
    }
    case 'text':
      return 'TEXT';
    case 'point':
      return 'POINT';
    case 'note':
      return item.value.note === 'dimension' ? 'DIMENSION' : 'LEADER';
    case 'shape':
      switch (item.value.shape) {
        case 'hatch':
        case 'gradient':
          return 'HATCH';
        case 'wipeout':
          return 'WIPEOUT';
        case 'donut':
          return 'DONUT';
        case 'xline':
          return 'XLINE';
        case 'ray':
          return 'RAY';
      }
      return 'HATCH';
    case 'table':
      return 'ACAD_TABLE';
    case 'copy':
      return file.view.entities[item.value.index]?.kind ?? 'LINE';
  }
}

/** A row's drawn shape (paths, texts, circle, nodes) from its page item. */
function rowShape(
  file: DrawingScene,
  preview: DrawingPreview,
  entry: PageItem,
): Pick<PageRow, 'paths' | 'texts' | 'arc' | 'nodes' | 'insert'> & { color: string | null } {
  const styled = entry.style?.color ?? null;
  const { item } = entry;
  const none = { paths: [], texts: [], color: styled };
  switch (item.type) {
    case 'curve': {
      const v = item.value;
      if (v.arc) {
        const path = arcPath(v.arc);
        return { paths: [path], texts: [], arc: v.arc, color: styled };
      }
      const flat = [...v.path];
      if (v.closed && flat.length >= 6) {
        const n = flat.length;
        if (flat[0] !== flat[n - 2] || flat[1] !== flat[n - 1]) flat.push(flat[0]!, flat[1]!);
      }
      return { paths: [atLeastTwo(flat)].filter((p) => p.length >= 4), texts: [], color: styled };
    }
    case 'text': {
      const v = item.value;
      return {
        paths: [],
        texts: [{ x: v.x, y: v.y, height: v.height, rotation: v.rotation ?? 0, text: v.text }],
        color: styled,
      };
    }
    case 'point':
      return {
        paths: [[item.value.x, item.value.y, item.value.x, item.value.y]],
        texts: [],
        nodes: [[item.value.x, item.value.y]],
        color: styled,
      };
    case 'note': {
      const pts = item.value.points;
      const [a, b, c] = pts;
      if (item.value.note === 'dimension' && a && b && c) {
        const dim = linearDimension(a, b, c);
        const seg = (s: readonly (readonly [number, number])[]) => s.flatMap((p) => [p[0], p[1]]);
        return {
          paths: [seg(dim.extensions[0]), seg(dim.extensions[1]), seg(dim.line)],
          texts: [],
          nodes: [a, b, dim.line[0], dim.line[1]],
          color: styled,
        };
      }
      const path = atLeastTwo(pts.flatMap((p) => [p[0], p[1]]));
      return { paths: path.length ? [path] : [], texts: [], color: styled };
    }
    case 'shape': {
      const v = item.value;
      const color = styled ?? v.color;
      const [first, second] = v.points;
      if (v.shape === 'donut' && first) {
        const r = Math.max(v.outer ?? 0, 0) / 2;
        if (!(r > 0)) return { ...none, paths: [[first[0], first[1], first[0], first[1]]] };
        const arc = { x: first[0], y: first[1], r, start: 0, end: 360 };
        return { paths: [arcPath(arc)], texts: [], arc, color };
      }
      if ((v.shape === 'xline' || v.shape === 'ray') && first && second) {
        // Infinite: drawn across far more than the drawing (picked and snapped along it).
        const e = file.view.extents;
        const far = 10 * Math.max(Math.hypot(e.maxX - e.minX, e.maxY - e.minY), 1);
        const len = Math.hypot(second[0] - first[0], second[1] - first[1]) || 1;
        const ux = (second[0] - first[0]) / len;
        const uy = (second[1] - first[1]) / len;
        const back = v.shape === 'xline' ? far : 0;
        return {
          paths: [[first[0] - ux * back, first[1] - uy * back, first[0] + ux * far, first[1] + uy * far]],
          texts: [],
          nodes: [first],
          color,
        };
      }
      const loops = [v.points, ...v.loops].filter((loop) => loop.length >= 2);
      return {
        paths: loops.map(closedFlat).filter((p) => p.length >= 4),
        texts: [],
        color,
      };
    }
    case 'table': {
      const paths = cellRects(item.value).map((c) => [
        c.x0,
        c.y0,
        c.x1,
        c.y0,
        c.x1,
        c.y1,
        c.x0,
        c.y1,
        c.x0,
        c.y0,
      ]);
      return { paths, texts: [], color: styled };
    }
    case 'copy': {
      const copy = item.value;
      const source = file.view.entities[copy.index];
      if (!source) return none;
      const t = copy.transform;
      const paths = source.paths.map((flat) => {
        const out: number[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const q = applyAffine(t, flat[i] as number, flat[i + 1] as number);
          out.push(q.x, q.y);
        }
        return out;
      });
      const turn = angleOf(t);
      const grow = scaleOf(t);
      const texts = source.texts.map((text) => {
        const q = applyAffine(t, text.x, text.y);
        return {
          ...text,
          x: q.x,
          y: q.y,
          height: text.height * grow,
          rotation: text.rotation + turn,
        };
      });
      const insert = source.insert;
      const moved = insert ? applyAffine(t, insert.x, insert.y) : null;
      return {
        paths,
        texts,
        ...(insert && moved
          ? {
              insert: {
                ...insert,
                x: moved.x,
                y: moved.y,
                rotation: insert.rotation + turn,
                scaleX: insert.scaleX * grow,
                scaleY: insert.scaleY * grow,
              },
            }
          : {}),
        color: styled ?? (copy.layer === undefined && !preview.layerOf.has(copy.index) ? source.color : null),
      };
    }
  }
}

/** The layer name of a page item (a copy of a file entity: its layer's). */
function itemLayerName(file: DrawingScene, preview: DrawingPreview, entry: PageItem): string | null {
  if (entry.item.type !== 'copy') return entry.item.value.layerName;
  const copy = entry.item.value;
  const layer =
    copy.layer ?? preview.layerOf.get(copy.index) ?? file.view.entities[copy.index]?.layer ?? -1;
  return file.view.layers[layer]?.name ?? null;
}

/** A map read through: `top` first, then `base` (no copy of the file's big maps). */
class OverlayMap<V> implements ReadonlyMap<string, V> {
  constructor(
    private readonly base: ReadonlyMap<string, V>,
    private readonly top: ReadonlyMap<string, V>,
  ) {}
  get(key: string): V | undefined {
    return this.top.has(key) ? this.top.get(key) : this.base.get(key);
  }
  has(key: string): boolean {
    return this.top.has(key) || this.base.has(key);
  }
  get size(): number {
    let n = this.base.size;
    for (const key of this.top.keys()) if (!this.base.has(key)) n += 1;
    return n;
  }
  *entries(): MapIterator<[string, V]> {
    for (const entry of this.base) if (!this.top.has(entry[0])) yield entry;
    yield* this.top.entries();
  }
  *keys(): MapIterator<string> {
    for (const [key] of this.entries()) yield key;
  }
  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
  forEach(fn: (value: V, key: string, map: ReadonlyMap<string, V>) => void): void {
    for (const [key, value] of this.entries()) fn(value, key, this);
  }
}

/** The file's grid, then the page rows' own grid (their indexes after the file's). */
class PageGrid implements SpatialIndex {
  constructor(
    private readonly file: SpatialIndex,
    private readonly rows: SpatialIndex,
    private readonly offset: number,
  ) {}
  query(box: Box, near?: { at: readonly [number, number]; limit: number }): Int32Array {
    const a = this.file.query(box, near);
    const b = this.rows.query(box, near);
    if (b.length === 0) return a;
    const out = new Int32Array(a.length + b.length);
    out.set(a);
    for (let i = 0; i < b.length; i++) out[a.length + i] = (b[i] as number) + this.offset;
    return out;
  }
}

const scenes = new WeakMap<DrawingPreview, { file: DrawingScene; scene: DrawingScene }>();

/**
 * The scene with the page's items as rows after the file's entities (cached per preview). The
 * file's scene itself when nothing was drawn on the page.
 */
export function pageSceneOf(fileIn: DrawingScene, preview: DrawingPreview): DrawingScene {
  const file = fileIn.file ?? fileIn;
  if (preview.page.length === 0 && preview.aliases.size === 0) return file;
  const cached = scenes.get(preview);
  if (cached && cached.file === file) return cached.scene;
  const scene = buildPageScene(file, preview);
  scenes.set(preview, { file, scene });
  return scene;
}

function buildPageScene(file: DrawingScene, preview: DrawingPreview): DrawingScene {
  const fileCount = file.view.entities.length;
  // Layers made on the page (not in the file's view) come after the file's, in the order seen.
  const pageLayers: DrawingViewLayer[] = [];
  const pageLayerIndex = new Map<string, number>();
  const layerCount = file.view.layers.length;
  const colorOfName = (name: string): string => {
    const like = preview.aliases.get(name);
    const index = file.layerByName.get(like ?? '');
    return (index === undefined ? undefined : file.view.layers[index]?.color) ?? FALLBACK_COLOR;
  };
  const addLayer = (name: string) => {
    if (!name || file.layerByName.has(name) || pageLayerIndex.has(name)) return;
    pageLayerIndex.set(name, layerCount + pageLayers.length);
    pageLayers.push({ name, color: colorOfName(name), visible: true });
  };
  for (const name of preview.aliases.keys()) addLayer(name);
  const names = preview.page.map((entry) => itemLayerName(file, preview, entry));
  for (const name of names) if (name !== null) addLayer(name);
  const layerOfName = (name: string | null): number =>
    name === null ? -1 : (file.layerByName.get(name) ?? pageLayerIndex.get(name) ?? -1);

  const rows: PageRow[] = preview.page.map((entry, k) => {
    const kind = pageItemKind(file, entry);
    const layer = layerOfName(names[k] ?? null);
    if (entry.erased) {
      return { handle: entry.handle, layer, color: null, kind, paths: [], texts: [], pageItem: k };
    }
    const { color, ...shape } = rowShape(file, preview, entry);
    return { handle: entry.handle, layer, color, kind, ...shape, pageItem: k };
  });

  const boxes = new Float64Array((fileCount + rows.length) * 4);
  boxes.set(file.boxes);
  const rowBoxes = new Float64Array(rows.length * 4);
  let ext: Box | null = null;
  rows.forEach((row, k) => {
    const empty = row.paths.length === 0 && row.texts.length === 0;
    const b = entityBox(row);
    const o = k * 4;
    rowBoxes[o] = b.minX;
    rowBoxes[o + 1] = b.minY;
    rowBoxes[o + 2] = b.maxX;
    rowBoxes[o + 3] = b.maxY;
    boxes.set(rowBoxes.subarray(o, o + 4), (fileCount + k) * 4);
    if (empty) return;
    ext = ext
      ? {
          minX: Math.min(ext.minX, b.minX),
          minY: Math.min(ext.minY, b.minY),
          maxX: Math.max(ext.maxX, b.maxX),
          maxY: Math.max(ext.maxY, b.maxY),
        }
      : b;
  });

  const handles = new Map<string, number[]>();
  rows.forEach((row, k) => {
    if (!row.handle) return;
    const list = handles.get(row.handle);
    if (list) list.push(fileCount + k);
    else handles.set(row.handle, [fileCount + k]);
  });

  const scene: DrawingScene = {
    view: {
      ...file.view,
      layers: pageLayers.length > 0 ? [...file.view.layers, ...pageLayers] : file.view.layers,
      entities: rows.length > 0 ? [...file.view.entities, ...rows] : file.view.entities,
    },
    origin: file.origin,
    boxes,
    byHandle: new OverlayMap(file.byHandle, handles),
    layerByName: new OverlayMap(file.layerByName, pageLayerIndex),
    file,
  };
  const rowScene: DrawingScene = {
    view: { ...file.view, extents: ext ?? file.view.extents, entities: rows },
    origin: file.origin,
    boxes: rowBoxes,
    byHandle: handles,
    layerByName: file.layerByName,
  };
  setEntityGrid(scene, new PageGrid(entityGridOf(file), new EntityGrid(rowScene), fileCount));
  return scene;
}
