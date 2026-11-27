import { bulgeThrough, flattenVertices, segmentMid, type BulgeVertex } from './bulge';
import {
  arcOfPoints,
  copyEdits,
  moveEdits,
  pointsCurveEdit,
  roundCoord,
  scaleEdits,
  setCurveEdit,
  type CanvasEdit,
} from './canvas-edit';
import type { DrawingPreview } from './drawing-preview';
import type { DrawingScene } from './drawing-scene';
import { drawnBox, geometryOf, type EntityGeometry, type Xy } from './entity-geometry';
import type { Bounds } from './view-transform';

/**
 * AutoCAD's grips (2D) on the picked objects (owner 2026-11-26, item 18): a line has its two ends
 * and its middle, a polyline its vertices and the middle of each segment, a circle its centre and
 * four quadrants, an arc its ends, middle and centre, an ellipse its centre and axis ends, a text
 * or a block reference ONE grip at its insertion point, and a group (GROUPDISPLAYMODE 2) one grip
 * at the middle of its box. Above GRIPOBJLIMIT picked objects no grips are shown.
 */

export const GRIP_OBJECT_LIMIT = 100;

export type GripKind =
  'end' | 'mid' | 'vertex' | 'segment' | 'center' | 'quadrant' | 'insert' | 'group' | 'axis';

export interface Grip {
  x: number;
  y: number;
  kind: GripKind;
  /** The entity; -1 for a group grip. */
  index: number;
  /** The vertex (end / vertex) or the segment's first vertex (segment); 0 otherwise. */
  vertex: number;
  /** Handles the grip moves (a group's members; the entity's own otherwise). */
  handles: readonly string[];
  /** The web view can stretch it (false: an ellipse axis, a spline end). */
  editable: boolean;
}

export interface GripSet {
  grips: Grip[];
  /** Boxes of the groups picked as one object (drawn dashed around the group). */
  groupBoxes: Bounds[];
}

const EMPTY: GripSet = { grips: [], groupBoxes: [] };

function entityGrips(index: number, handle: string, g: EntityGeometry): Grip[] {
  const make = (p: Xy, kind: GripKind, vertex = 0, editable = true): Grip => ({
    x: p.x,
    y: p.y,
    kind,
    index,
    vertex,
    handles: [handle],
    editable,
  });
  const middle = (a: Xy, b: Xy): Xy => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  switch (g.type) {
    case 'line':
      return [make(g.start, 'end', 0), make(middle(g.start, g.end), 'mid'), make(g.end, 'end', 1)];
    case 'polyline': {
      const out: Grip[] = [];
      if (g.vertices) {
        // ADR-062 (item 33): grips on the real vertices; an arc segment's grip on its middle.
        const vs = g.vertices;
        const count = vs.length;
        vs.forEach((v, i) => {
          out.push(make(v, 'vertex', i));
          const next = vs[i + 1] ?? (g.closed && count > 2 ? vs[0] : undefined);
          if (next) out.push(make(segmentMid(v, next, v.bulge), 'segment', i));
        });
        return out;
      }
      const n = g.points.length;
      g.points.forEach((p, i) => {
        out.push(make(p, 'vertex', i));
        const next = g.points[i + 1] ?? (g.closed && n > 2 ? g.points[0] : undefined);
        if (next) out.push(make(middle(p, next), 'segment', i));
      });
      return out;
    }
    case 'circle': {
      const { center: c, radius: r } = g;
      return [
        make(c, 'center'),
        make({ x: c.x + r, y: c.y }, 'quadrant'),
        make({ x: c.x, y: c.y + r }, 'quadrant'),
        make({ x: c.x - r, y: c.y }, 'quadrant'),
        make({ x: c.x, y: c.y - r }, 'quadrant'),
      ];
    }
    case 'arc':
      return [
        make(g.start, 'end', 0),
        make(g.mid, 'mid', 0),
        make(g.end, 'end', 1),
        make(g.center, 'center'),
      ];
    case 'ellipse':
      return [
        make(g.center, 'center'),
        ...[...g.major, ...g.minor].map((p) => make(p, 'axis', 0, false)),
      ];
    case 'spline':
      return g.closed
        ? [make(g.start, 'end', 0, false)]
        : [make(g.start, 'end', 0, false), make(g.end, 'end', 1, false)];
    case 'text':
      return [make(g.at, 'insert')];
    case 'insert':
      return g.at ? [make(g.at, 'insert')] : [];
    case 'other':
      // A hatch and the like: AutoCAD's one grip in the middle.
      return [
        make(middle({ x: g.box.minX, y: g.box.minY }, { x: g.box.maxX, y: g.box.maxY }), 'center'),
      ];
  }
}

/**
 * The grips of the picked objects. A group (or a block made on the page) whose shown members are
 * all picked, with group selection on (always for a page block), is one object with one grip.
 */
export function gripsOf(
  scene: DrawingScene,
  preview: DrawingPreview,
  chosen: ReadonlySet<number>,
  groupPick: boolean,
): GripSet {
  if (chosen.size === 0) return EMPTY;
  const grips: Grip[] = [];
  const groupBoxes: Bounds[] = [];
  const done = new Set<number>();
  for (const group of preview.groups.values()) {
    if (!groupPick && !group.block) continue;
    const members = group.handles.flatMap((h) => [...(scene.byHandle.get(h) ?? [])]);
    const picked = members.filter((i) => chosen.has(i));
    if (picked.length === 0 || picked.length < members.filter((i) => !preview.erased.has(i)).length)
      continue;
    let box: Bounds | null = null;
    for (const i of picked) {
      const b = drawnBox(scene, preview, i);
      box = box
        ? {
            minX: Math.min(box.minX, b.minX),
            minY: Math.min(box.minY, b.minY),
            maxX: Math.max(box.maxX, b.maxX),
            maxY: Math.max(box.maxY, b.maxY),
          }
        : b;
      done.add(i);
    }
    if (!box) continue;
    groupBoxes.push(box);
    grips.push({
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      kind: 'group',
      index: -1,
      vertex: 0,
      handles: group.handles,
      editable: true,
    });
  }
  const objects = new Set<string>();
  for (const index of chosen) {
    if (done.has(index)) continue;
    objects.add(scene.view.entities[index]?.handle ?? String(index));
  }
  if (objects.size + groupBoxes.length > GRIP_OBJECT_LIMIT) return EMPTY;
  const seen = new Set<string>();
  for (const index of chosen) {
    if (done.has(index)) continue;
    const handle = scene.view.entities[index]?.handle;
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    const geometry = geometryOf(scene, preview, index);
    if (geometry) grips.push(...entityGrips(index, handle, geometry));
  }
  return { grips, groupBoxes };
}

/** The grip under a screen point (within `tolerance` px), the nearest first. */
export function hitGrip(
  grips: readonly Grip[],
  toScreenPoint: (x: number, y: number) => Xy,
  sx: number,
  sy: number,
  tolerance: number,
): Grip | null {
  let best: Grip | null = null;
  let bestD = Infinity;
  for (const grip of grips) {
    const p = toScreenPoint(grip.x, grip.y);
    const d = Math.max(Math.abs(p.x - sx), Math.abs(p.y - sy));
    if (d <= tolerance && d < bestD) {
      best = grip;
      bestD = d;
    }
  }
  return best;
}

type ArcValue = { x: number; y: number; r: number; start: number; end: number };

/** Points of the arc through three points (first → through → last), for the screen. */
function arcThrough(a: Xy, m: Xy, b: Xy): { points: [number, number][]; arc: ArcValue } | null {
  const arc = arcOfPoints([
    [a.x, a.y],
    [m.x, m.y],
    [b.x, b.y],
  ]);
  if (!arc) return null;
  const sweep = arc.end - arc.start;
  const steps = Math.max(2, Math.ceil((sweep / 360) * 64));
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((arc.start + (sweep * i) / steps) * Math.PI) / 180;
    points.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]);
  }
  // The points run counter-clockwise; keep the object's own direction (first → last).
  const first = points[0] as [number, number];
  if (Math.hypot(first[0] - a.x, first[1] - a.y) > Math.hypot(first[0] - b.x, first[1] - b.y)) {
    points.reverse();
  }
  // The ends stay exactly where the grips put them (the centre is rounded).
  points[0] = [a.x, a.y];
  points[points.length - 1] = [b.x, b.y];
  return { points, arc };
}

const MOVING_KINDS = new Set<GripKind>(['group', 'insert', 'center']);

/**
 * A polyline with real vertices and bulges (ADR-062): `set_curve` of `handle` (or, with no handle,
 * a new curve on `layerName`) whose points are the flattened path the build reads.
 */
export function vertexCurveEdit(
  handle: string | null,
  layerName: string,
  vertices: readonly BulgeVertex[],
  closed: boolean,
): CanvasEdit {
  const points = flattenVertices(vertices, closed);
  const kept = vertices.map(
    (v) => [roundCoord(v.x), roundCoord(v.y), roundCoord(v.bulge) + 0] as [number, number, number],
  );
  if (handle === null) {
    const edit = pointsCurveEdit(layerName, points, closed);
    return edit.kind === 'add_curve' ? { ...edit, vertices: kept } : edit;
  }
  const edit = setCurveEdit(handle, points, closed);
  return edit.kind === 'set_curve' ? { ...edit, vertices: kept } : edit;
}

/** The edits of the hot grips of one object moved by (dx, dy); null when the web cannot. */
function objectStretch(
  geometry: EntityGeometry,
  handle: string,
  grips: readonly Grip[],
  dx: number,
  dy: number,
  copy: boolean,
  layerName: string,
): CanvasEdit[] | null {
  const move = () => (copy ? copyEdits([handle], dx, dy) : moveEdits([handle], dx, dy));
  const moved = (p: Xy): Xy => ({ x: p.x + dx, y: p.y + dy });
  if (grips.some((g) => MOVING_KINDS.has(g.kind))) return move();
  if (geometry.type === 'circle') {
    const quadrant = grips.find((g) => g.kind === 'quadrant');
    if (!quadrant || copy) return null;
    const radius = Math.hypot(
      quadrant.x + dx - geometry.center.x,
      quadrant.y + dy - geometry.center.y,
    );
    if (!(radius > 0) || !(geometry.radius > 0)) return null;
    return scaleEdits(
      [handle],
      geometry.center.x,
      geometry.center.y,
      roundCoord(radius / geometry.radius),
    );
  }
  if (geometry.type === 'arc') {
    // AutoCAD: the arc goes through its three grips, the hot ones where they are dragged to.
    const at = (kind: GripKind, vertex: number, p: Xy) =>
      grips.some((g) => g.kind === kind && g.vertex === vertex) ? moved(p) : p;
    const made = arcThrough(
      at('end', 0, geometry.start),
      at('mid', 0, geometry.mid),
      at('end', 1, geometry.end),
    );
    if (!made) return null;
    if (copy) {
      const edit = pointsCurveEdit(layerName, made.points, false);
      return edit.kind === 'add_curve' ? [{ ...edit, arc: made.arc }] : [edit];
    }
    const edit = setCurveEdit(handle, made.points, false);
    return edit.kind === 'set_curve' ? [{ ...edit, arc: made.arc }] : [edit];
  }
  if (geometry.type === 'line') {
    if (grips.some((g) => g.kind === 'mid')) return move();
    const pairs = [geometry.start, geometry.end].map((p, i) => {
      const q = grips.some((g) => g.kind === 'end' && g.vertex === i) ? moved(p) : p;
      return [q.x, q.y] as [number, number];
    });
    return [copy ? pointsCurveEdit(layerName, pairs, false) : setCurveEdit(handle, pairs, false)];
  }
  if (geometry.type !== 'polyline') return null;
  const closed = geometry.closed;
  const shifted = new Set<number>();
  if (geometry.vertices) {
    const vs: BulgeVertex[] = geometry.vertices.map((v) => ({ ...v }));
    const n = vs.length;
    const bent = new Map<number, number>();
    for (const g of grips) {
      if (g.kind === 'vertex') shifted.add(g.vertex);
      else if (g.kind === 'segment') {
        const a = vs[g.vertex];
        const b = vs[(g.vertex + 1) % n];
        if (!a || !b) continue;
        // An arc segment's middle bends the arc through the new point; a straight one moves.
        if (Math.abs(a.bulge) > 1e-12) bent.set(g.vertex, bulgeThrough(a, b, moved(g)));
        else {
          shifted.add(g.vertex);
          shifted.add((g.vertex + 1) % n);
        }
      }
    }
    for (const i of shifted) {
      const v = vs[i];
      if (v) vs[i] = { ...v, x: v.x + dx, y: v.y + dy };
    }
    for (const [i, bulge] of bent) {
      const v = vs[i];
      if (v) vs[i] = { ...v, bulge };
    }
    return [vertexCurveEdit(copy ? null : handle, layerName, vs, closed)];
  }
  const points = [...geometry.points];
  for (const g of grips) {
    if (g.kind === 'end' || g.kind === 'vertex') shifted.add(g.vertex);
    else if (g.kind === 'segment') {
      shifted.add(g.vertex);
      shifted.add((g.vertex + 1) % points.length);
    }
  }
  if (shifted.size === 0) return null;
  for (const i of shifted) {
    const p = points[i];
    if (p) points[i] = moved(p);
  }
  const pairs = points.map((p) => [p.x, p.y] as [number, number]);
  return [copy ? pointsCurveEdit(layerName, pairs, closed) : setCurveEdit(handle, pairs, closed)];
}

/**
 * The edits of a grip STRETCH of the hot grips from `base` to `to` (AutoCAD): an end / vertex
 * moves alone, a polyline segment's middle moves its two vertices (an arc segment's bends the arc
 * through the new point), an arc goes through its three grips, a line middle / centre / insertion
 * point / group grip moves the object, a circle quadrant changes the radius. Several hot grips
 * (Shift+click) move together. With `copy` the original stays and a copy takes the change. Null
 * when the web view cannot do it.
 */
export function gripsStretchEdits(
  scene: DrawingScene,
  preview: DrawingPreview,
  hot: readonly Grip[],
  base: Xy,
  to: Xy,
  copy: boolean,
  layerOf: (index: number) => string,
): CanvasEdit[] | null {
  if (hot.length === 0 || hot.some((g) => !g.editable)) return null;
  const dx = to.x - base.x;
  const dy = to.y - base.y;
  const out: CanvasEdit[] = [];
  const byObject = new Map<number, Grip[]>();
  for (const g of hot) {
    if (g.index < 0) {
      out.push(...(copy ? copyEdits(g.handles, dx, dy) : moveEdits(g.handles, dx, dy)));
      continue;
    }
    byObject.set(g.index, [...(byObject.get(g.index) ?? []), g]);
  }
  for (const [index, grips] of byObject) {
    const geometry = geometryOf(scene, preview, index);
    const handle = grips[0]?.handles[0];
    if (!geometry || !handle) return null;
    const made = objectStretch(geometry, handle, grips, dx, dy, copy, layerOf(index));
    if (!made) return null;
    out.push(...made);
  }
  return out;
}

/** One hot grip's STRETCH (see `gripsStretchEdits`). */
export function gripStretchEdits(
  scene: DrawingScene,
  preview: DrawingPreview,
  grip: Grip,
  base: Xy,
  to: Xy,
  copy: boolean,
  layerName: string,
): CanvasEdit[] | null {
  return gripsStretchEdits(scene, preview, [grip], base, to, copy, () => layerName);
}

/** Where a grip STRETCH would put the objects, for the rubber band: their new points. */
export function gripSketches(
  scene: DrawingScene,
  preview: DrawingPreview,
  hot: readonly Grip[],
  base: Xy,
  to: Xy,
): { points: Xy[]; closed: boolean }[] {
  const out: { points: Xy[]; closed: boolean }[] = [];
  const quadrant = hot.find((g) => g.kind === 'quadrant');
  const circle = quadrant ? geometryOf(scene, preview, quadrant.index) : null;
  if (quadrant && circle?.type === 'circle') {
    const r = Math.hypot(
      quadrant.x + to.x - base.x - circle.center.x,
      quadrant.y + to.y - base.y - circle.center.y,
    );
    const points = Array.from({ length: 48 }, (_, i) => ({
      x: circle.center.x + r * Math.cos((i / 48) * 2 * Math.PI),
      y: circle.center.y + r * Math.sin((i / 48) * 2 * Math.PI),
    }));
    out.push({ points, closed: true });
  }
  for (const edit of gripsStretchEdits(scene, preview, hot, base, to, false, () => '') ?? []) {
    if (edit.kind === 'set_curve') {
      out.push({ points: edit.points.map((p) => ({ x: p[0], y: p[1] })), closed: edit.closed });
    }
  }
  return out.length > 0 ? out : [{ points: [base, to], closed: false }];
}

/** Where a grip STRETCH would put the object, for the rubber band: its new points, or null. */
export function gripSketch(
  scene: DrawingScene,
  preview: DrawingPreview,
  grip: Grip,
  base: Xy,
  to: Xy,
): { points: Xy[]; closed: boolean } | null {
  return gripSketches(scene, preview, [grip], base, to)[0] ?? null;
}
