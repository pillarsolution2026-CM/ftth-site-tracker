import {
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
  /** The web view can stretch it (false: an arc end, an ellipse axis, a spline end). */
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
        make(g.start, 'end', 0, false),
        make(g.mid, 'mid', 0, false),
        make(g.end, 'end', 1, false),
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

/**
 * The edits of a grip STRETCH from `base` to `to` (AutoCAD): an end / vertex moves alone, a
 * polyline segment's middle moves its two vertices, a line middle / centre / insertion point /
 * group grip moves the object, a circle quadrant changes the radius. With `copy` the original stays
 * and a copy takes the change. Null when the web view cannot do it.
 */
export function gripStretchEdits(
  scene: DrawingScene,
  preview: DrawingPreview,
  grip: Grip,
  base: Xy,
  to: Xy,
  copy: boolean,
  layerName: string,
): CanvasEdit[] | null {
  if (!grip.editable) return null;
  const dx = to.x - base.x;
  const dy = to.y - base.y;
  const move = () => (copy ? copyEdits(grip.handles, dx, dy) : moveEdits(grip.handles, dx, dy));
  if (grip.kind === 'group' || grip.kind === 'insert' || grip.kind === 'center') return move();
  const geometry = geometryOf(scene, preview, grip.index);
  const handle = grip.handles[0];
  if (!geometry || !handle) return null;
  if (grip.kind === 'quadrant' && geometry.type === 'circle') {
    if (copy) return null;
    const radius = Math.hypot(to.x - geometry.center.x, to.y - geometry.center.y);
    if (!(radius > 0) || !(geometry.radius > 0)) return null;
    return scaleEdits(
      [handle],
      geometry.center.x,
      geometry.center.y,
      roundCoord(radius / geometry.radius),
    );
  }
  let points: Xy[];
  let closed = false;
  if (geometry.type === 'line') points = [geometry.start, geometry.end];
  else if (geometry.type === 'polyline') {
    points = [...geometry.points];
    closed = geometry.closed;
  } else return null;
  if (grip.kind === 'mid' && geometry.type === 'line') return move();
  const shift = (i: number) => {
    const p = points[i];
    if (p) points[i] = { x: p.x + dx, y: p.y + dy };
  };
  if (grip.kind === 'end' || grip.kind === 'vertex') shift(grip.vertex);
  else if (grip.kind === 'segment') {
    shift(grip.vertex);
    shift((grip.vertex + 1) % points.length);
  } else return null;
  const pairs = points.map((p) => [p.x, p.y] as [number, number]);
  return [copy ? pointsCurveEdit(layerName, pairs, closed) : setCurveEdit(handle, pairs, closed)];
}

/** Where a grip STRETCH would put the object, for the rubber band: its new points, or null. */
export function gripSketch(
  scene: DrawingScene,
  preview: DrawingPreview,
  grip: Grip,
  base: Xy,
  to: Xy,
): { points: Xy[]; closed: boolean } | null {
  const geometry = geometryOf(scene, preview, grip.index);
  if (!geometry || !grip.editable) return { points: [base, to], closed: false };
  if (geometry.type === 'circle' && grip.kind === 'quadrant') {
    const r = Math.hypot(to.x - geometry.center.x, to.y - geometry.center.y);
    const points = Array.from({ length: 48 }, (_, i) => ({
      x: geometry.center.x + r * Math.cos((i / 48) * 2 * Math.PI),
      y: geometry.center.y + r * Math.sin((i / 48) * 2 * Math.PI),
    }));
    return { points, closed: true };
  }
  const edits = gripStretchEdits(scene, preview, grip, base, to, false, '');
  const curve = edits?.[0];
  if (curve && curve.kind === 'set_curve') {
    return { points: curve.points.map((p) => ({ x: p[0], y: p[1] })), closed: curve.closed };
  }
  return { points: [base, to], closed: false };
}
