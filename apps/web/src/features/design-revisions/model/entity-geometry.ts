import { angleOf, applyAffine, IDENTITY, scaleOf, type Affine } from './affine';
import type { DrawingPreview } from './drawing-preview';
import { boxOf, type DrawingScene } from './drawing-scene';
import { isPageRow } from './page-scene';
import type { Bounds } from './view-transform';

/**
 * What a drawing object is, as AutoCAD knows it (2D), read from the view as it is drawn now
 * (moves, curve edits and text changes applied): the base of the grips and the Properties palette
 * (owner 2026-11-26). The view keeps curves as flattened polylines, so a circle's centre and radius
 * and an arc's centre are worked out from its drawn points; nothing is invented.
 */

export interface Xy {
  x: number;
  y: number;
}

export type EntityGeometry =
  | { type: 'line'; start: Xy; end: Xy }
  | { type: 'polyline'; points: Xy[]; closed: boolean }
  | { type: 'circle'; center: Xy; radius: number }
  | { type: 'arc'; center: Xy; radius: number; start: Xy; mid: Xy; end: Xy }
  | { type: 'ellipse'; center: Xy; major: [Xy, Xy]; minor: [Xy, Xy] }
  | { type: 'spline'; start: Xy; end: Xy; closed: boolean }
  | { type: 'text'; kind: 'TEXT' | 'MTEXT'; at: Xy; height: number; rotation: number; text: string }
  | {
      type: 'insert';
      /** The insertion point; null when the view of this file does not carry it. */
      at: Xy | null;
      rotation: number | null;
      scaleX: number | null;
      scaleY: number | null;
      name: string | null;
      /** The attribute / text values inside the block. */
      values: string[];
    }
  | { type: 'other'; kind: string; box: Bounds };

const CURVES = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE']);
const dist = (a: Xy, b: Xy) => Math.hypot(a.x - b.x, a.y - b.y);

/** The entity's drawn points (its first path), moves applied; a set_curve replaces them. */
function drawnPoints(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): { points: Xy[]; closed: boolean } | null {
  const entity = scene.view.entities[index];
  if (!entity) return null;
  const moved = preview.transformOf.get(index) ?? IDENTITY;
  const replaced = preview.curveOf.get(index);
  let points: Xy[];
  let closed: boolean;
  if (replaced) {
    points = replaced.points.map((p) => applyAffine(moved, p[0], p[1]));
    closed = replaced.closed;
  } else {
    const flat = entity.paths[0];
    if (!flat || entity.paths.length !== 1) return null;
    points = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      points.push(applyAffine(moved, flat[i] as number, flat[i + 1] as number));
    }
    closed = false;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!replaced && points.length > 2 && first && last && dist(first, last) < 1e-9) {
    points = points.slice(0, -1);
    closed = true;
  }
  return points.length >= 2 ? { points, closed } : null;
}

/** The circle through three points; null when they are in a line. */
export function circleThrough(a: Xy, b: Xy, c: Xy): { center: Xy; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
  return { center, radius: dist(center, a) };
}

function boundsOf(points: readonly Xy[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** The drawn box of an entity (moves applied). */
export function drawnBox(scene: DrawingScene, preview: DrawingPreview, index: number): Bounds {
  const moved: Affine = preview.transformOf.get(index) ?? IDENTITY;
  const replaced = preview.curveOf.get(index);
  if (replaced && replaced.points.length > 0) {
    return boundsOf(replaced.points.map((p) => applyAffine(moved, p[0], p[1])));
  }
  const box = boxOf(scene, index);
  return boundsOf(
    [
      [box.minX, box.minY],
      [box.maxX, box.minY],
      [box.maxX, box.maxY],
      [box.minX, box.maxY],
    ].map(([x, y]) => applyAffine(moved, x as number, y as number)),
  );
}

export function geometryOf(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): EntityGeometry | null {
  const entity = scene.view.entities[index];
  if (!entity) return null;
  const kind = entity.kind.toUpperCase();
  const moved = preview.transformOf.get(index) ?? IDENTITY;
  // A circle / arc drawn on the page is a true one (add_curve.arc, ADR-061).
  if (isPageRow(entity) && entity.arc) {
    const { x, y, r, start, end } = entity.arc;
    const center = { x, y };
    const at = (deg: number): Xy => ({
      x: x + r * Math.cos((deg * Math.PI) / 180),
      y: y + r * Math.sin((deg * Math.PI) / 180),
    });
    if (end - start >= 360 - 1e-9) return { type: 'circle', center, radius: r };
    return {
      type: 'arc',
      center,
      radius: r,
      start: at(start),
      mid: at((start + end) / 2),
      end: at(end),
    };
  }
  if (kind === 'TEXT' || kind === 'MTEXT') {
    const first = entity.texts[0];
    if (!first) return { type: 'other', kind, box: drawnBox(scene, preview, index) };
    return {
      type: 'text',
      kind,
      at: applyAffine(moved, first.x, first.y),
      height: first.height * scaleOf(moved),
      rotation: normalAngle(first.rotation + angleOf(moved)),
      text: preview.textOf.get(index) ?? first.text,
    };
  }
  if (kind === 'INSERT') {
    const insert = entity.insert;
    const changed = preview.attrOf.get(index);
    const values = entity.texts.map((text) => changed?.get(text.text) ?? text.text);
    if (!insert) {
      return {
        type: 'insert',
        at: null,
        rotation: null,
        scaleX: null,
        scaleY: null,
        name: null,
        values,
      };
    }
    const factor = scaleOf(moved);
    return {
      type: 'insert',
      at: applyAffine(moved, insert.x, insert.y),
      rotation: normalAngle(insert.rotation + angleOf(moved)),
      scaleX: insert.scaleX * factor,
      scaleY: insert.scaleY * factor,
      name: insert.name,
      values,
    };
  }
  const drawn = drawnPoints(scene, preview, index);
  if (CURVES.has(kind) || preview.curveOf.has(index)) {
    if (!drawn) return { type: 'other', kind, box: drawnBox(scene, preview, index) };
    const [a, b] = drawn.points;
    if (kind === 'LINE' && drawn.points.length === 2 && a && b && !drawn.closed) {
      return { type: 'line', start: a, end: b };
    }
    return { type: 'polyline', points: drawn.points, closed: drawn.closed };
  }
  if (!drawn) return { type: 'other', kind, box: drawnBox(scene, preview, index) };
  const pts = drawn.points;
  if (kind === 'CIRCLE') {
    const box = boundsOf(pts);
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const radius = pts.reduce((sum, p) => sum + dist(center, p), 0) / pts.length;
    return { type: 'circle', center, radius };
  }
  if (kind === 'ARC') {
    const start = pts[0] as Xy;
    const end = pts[pts.length - 1] as Xy;
    const mid = pts[Math.floor(pts.length / 2)] as Xy;
    const circle = pts.length >= 3 ? circleThrough(start, mid, end) : null;
    if (!circle) return { type: 'polyline', points: pts, closed: false };
    return { type: 'arc', center: circle.center, radius: circle.radius, start, mid, end };
  }
  if (kind === 'ELLIPSE' && drawn.closed && pts.length >= 4) {
    const center = {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
    const far = pts.reduce((best, p) => (dist(center, p) > dist(center, best) ? p : best));
    const near = pts.reduce((best, p) => (dist(center, p) < dist(center, best) ? p : best));
    const opposite = (p: Xy): Xy => ({ x: 2 * center.x - p.x, y: 2 * center.y - p.y });
    return { type: 'ellipse', center, major: [far, opposite(far)], minor: [near, opposite(near)] };
  }
  if (kind === 'SPLINE') {
    return {
      type: 'spline',
      start: pts[0] as Xy,
      end: (drawn.closed ? pts[0] : pts[pts.length - 1]) as Xy,
      closed: drawn.closed,
    };
  }
  return { type: 'other', kind, box: drawnBox(scene, preview, index) };
}

/** Degrees in [0, 360). */
export function normalAngle(degrees: number): number {
  const out = ((degrees % 360) + 360) % 360;
  return Math.abs(out - 360) < 1e-9 ? 0 : out;
}

/** Length of a polyline (closed: back to the first point). */
export function polylineLength(points: readonly Xy[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1] as Xy, points[i] as Xy);
  if (closed && points.length > 2) total += dist(points[points.length - 1] as Xy, points[0] as Xy);
  return total;
}

/** Area inside a closed polyline (shoelace), always positive. */
export function polygonArea(points: readonly Xy[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Xy;
    const b = points[(i + 1) % points.length] as Xy;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** AutoCAD's object name in the Properties palette. */
export function objectName(geometry: EntityGeometry | null, kind: string): string {
  // A donut is a polyline in AutoCAD.
  if (kind.toUpperCase() === 'DONUT') return 'Polyline';
  switch (geometry?.type) {
    case 'line':
      return 'Line';
    case 'polyline':
      return kind === 'LINE' ? 'Line' : 'Polyline';
    case 'circle':
      return 'Circle';
    case 'arc':
      return 'Arc';
    case 'ellipse':
      return 'Ellipse';
    case 'spline':
      return 'Spline';
    case 'text':
      return geometry.kind === 'MTEXT' ? 'MText' : 'Text';
    case 'insert':
      return 'Block Reference';
    default: {
      const k = kind.toUpperCase();
      const names: Record<string, string> = {
        HATCH: 'Hatch',
        POINT: 'Point',
        DIMENSION: 'Rotated Dimension',
        LEADER: 'Leader',
        MLEADER: 'Multileader',
        SOLID: '2D Solid',
        WIPEOUT: 'Wipeout',
        ACAD_TABLE: 'Table',
      };
      return names[k] ?? k.charAt(0) + k.slice(1).toLowerCase();
    }
  }
}
