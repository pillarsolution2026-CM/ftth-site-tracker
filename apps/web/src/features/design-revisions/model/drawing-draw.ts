import type { DrawingViewEntity } from '@ftth/shared';
import { effectiveLayer, type DrawingPreview } from './drawing-preview';
import type { ProblemMarker } from './drawing-hit';
import { boxOf, cullEntities, paperColor, resolveColor, type DrawingScene } from './drawing-scene';
import { toScreen, visibleBounds, type Size, type ViewTransform } from './view-transform';

/** Texts smaller than this on screen (px of text height) are not drawn. */
export const MIN_TEXT_PX = 3;
/** Font size per CAD text height (the height is the capital letters' height). */
export const TEXT_FONT_FACTOR = 1.35;
/** Shapes whose box is smaller than this on screen (px) are skipped (no text). */
const MIN_SHAPE_PX = 0.4;
export const MARKER_RADIUS_PX = 10;
/** Labels of problem markers are dropped when more than this many are on screen. */
const MAX_MARKER_LABELS = 300;

export const MARKER_ERROR_COLOR = '#d32f2f';
export const MARKER_FIXED_COLOR = '#2e7d32';
const HIGHLIGHT_HALO = '#ffb300';
const SELECTED_COLOR = '#0277bd';
/** Routes marked for trench (ADR-042): dashed purple, never colour alone (also a text label). */
export const TRENCH_COLOR = '#6a1b9a';

export interface DrawModel {
  scene: DrawingScene;
  preview: DrawingPreview;
  /** Is the layer (index, -1 = unknown layer) switched on. */
  layerShown: (layerIndex: number) => boolean;
  markers: readonly ProblemMarker[];
  /** Entities to highlight with a halo (the place the user asked to see). */
  highlighted: ReadonlySet<number>;
  /** The clicked entity. */
  selected: number | null;
  /** Entities marked for trench → the text drawn on them (e.g. «Trench: 25.000 m»). */
  trench?: ReadonlyMap<number, string>;
}

export interface Viewport extends Size {
  dpr: number;
}

/** Path2D of each entity, built when first drawn, in coordinates relative to the scene origin. */
export class PathCache {
  private readonly paths: (Path2D | undefined)[];

  constructor(private readonly scene: DrawingScene) {
    this.paths = new Array<Path2D | undefined>(scene.view.entities.length);
  }

  get(index: number): Path2D {
    const cached = this.paths[index];
    if (cached) return cached;
    const entity = this.scene.view.entities[index] as DrawingViewEntity;
    const { x: ox, y: oy } = this.scene.origin;
    const path = new Path2D();
    for (const points of entity.paths) {
      path.moveTo((points[0] as number) - ox, (points[1] as number) - oy);
      for (let i = 2; i + 1 < points.length; i += 2) {
        path.lineTo((points[i] as number) - ox, (points[i + 1] as number) - oy);
      }
    }
    this.paths[index] = path;
    return path;
  }
}

/** World (relative to origin, Y up) → device pixels. */
function setWorldTransform(
  ctx: CanvasRenderingContext2D,
  scene: DrawingScene,
  tf: ViewTransform,
  vp: Viewport,
) {
  const { x: ox, y: oy } = scene.origin;
  ctx.setTransform(
    tf.scale * vp.dpr,
    0,
    0,
    -tf.scale * vp.dpr,
    ((ox - tf.cx) * tf.scale + vp.width / 2) * vp.dpr,
    (vp.height / 2 - (oy - tf.cy) * tf.scale) * vp.dpr,
  );
}

const setScreenTransform = (ctx: CanvasRenderingContext2D, vp: Viewport) =>
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

function fillTextAt(
  ctx: CanvasRenderingContext2D,
  tf: ViewTransform,
  vp: Viewport,
  x: number,
  y: number,
  height: number,
  rotation: number,
  text: string,
) {
  const px = height * tf.scale;
  if (px < MIN_TEXT_PX || px > 5000) return;
  const p = toScreen(tf, vp, x, y);
  if (p.x < -px * text.length || p.x > vp.width + px || p.y < -px || p.y > vp.height + px) return;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (rotation !== 0) ctx.rotate((-rotation * Math.PI) / 180);
  ctx.font = `${px * TEXT_FONT_FACTOR}px sans-serif`;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** The drawing itself: entity strokes, then texts, on white. Heavy; redraw only on change. */
export function drawBase(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { scene, preview } = model;
  const { entities, layers } = scene.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, vp.width * vp.dpr, vp.height * vp.dpr);

  const candidates = cullEntities(scene, visibleBounds(tf, vp));
  const shown: number[] = [];
  for (const index of candidates) {
    if (model.layerShown(effectiveLayer(scene, preview, index))) shown.push(index);
  }

  setWorldTransform(ctx, scene, tf, vp);
  ctx.lineWidth = 1 / tf.scale;
  ctx.lineJoin = 'round';
  let current = '';
  const texted: number[] = [];
  for (const index of shown) {
    const entity = entities[index] as DrawingViewEntity;
    if (entity.texts.length > 0) texted.push(index);
    if (entity.paths.length === 0) continue;
    const box = boxOf(scene, index);
    if (
      (box.maxX - box.minX) * tf.scale < MIN_SHAPE_PX &&
      (box.maxY - box.minY) * tf.scale < MIN_SHAPE_PX
    ) {
      continue;
    }
    const moved = preview.layerOf.has(index);
    const color = paperColor(
      resolveColor(entity, layers, effectiveLayer(scene, preview, index), moved),
    );
    if (color !== current) {
      ctx.strokeStyle = color;
      current = color;
    }
    ctx.stroke(cache.get(index));
  }

  setScreenTransform(ctx, vp);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  current = '';
  for (const index of texted) {
    const entity = entities[index] as DrawingViewEntity;
    const moved = preview.layerOf.has(index);
    const color = paperColor(
      resolveColor(entity, layers, effectiveLayer(scene, preview, index), moved),
    );
    if (color !== current) {
      ctx.fillStyle = color;
      current = color;
    }
    const replaced = preview.textOf.get(index);
    entity.texts.forEach((text, i) => {
      fillTextAt(
        ctx,
        tf,
        vp,
        text.x,
        text.y,
        text.height,
        text.rotation,
        i === 0 && replaced !== undefined ? replaced : text.text,
      );
    });
  }
  for (const extra of preview.extraTexts) {
    if (!model.layerShown(extra.layer)) continue;
    ctx.fillStyle = paperColor(extra.color);
    fillTextAt(ctx, tf, vp, extra.x, extra.y, extra.height, 0, extra.text);
  }
}

function boxOutline(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  index: number,
  color: string,
) {
  const box = boxOf(model.scene, index);
  const a = toScreen(tf, vp, box.minX, box.maxY);
  const b = toScreen(tf, vp, box.maxX, box.minY);
  const pad = 5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(
    a.x - pad,
    a.y - pad,
    Math.max(8, b.x - a.x) + pad * 2,
    Math.max(8, b.y - a.y) + pad * 2,
  );
  ctx.setLineDash([]);
}

/** The written trench length at the middle of each marked route (screen text, LTR digits). */
function drawTrenchLabels(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  inView: (index: number) => boolean,
  shown: (index: number) => boolean,
) {
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [index, text] of model.trench ?? []) {
    if (!inView(index) || !shown(index)) continue;
    const box = boxOf(model.scene, index);
    const p = toScreen(tf, vp, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(p.x - width / 2, p.y - 10, width, 20);
    ctx.strokeStyle = TRENCH_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - width / 2, p.y - 10, width, 20);
    ctx.fillStyle = TRENCH_COLOR;
    ctx.fillText(text, p.x, p.y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  marker: ProblemMarker,
  tf: ViewTransform,
  vp: Viewport,
  withLabel: boolean,
) {
  const p = toScreen(tf, vp, marker.x, marker.y);
  if (p.x < -60 || p.y < -20 || p.x > vp.width + 200 || p.y > vp.height + 20) return;
  const r = MARKER_RADIUS_PX;
  ctx.setLineDash([]);
  if (marker.fixed) {
    ctx.fillStyle = MARKER_FIXED_COLOR;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(p.x - r * 0.5, p.y);
    ctx.lineTo(p.x - r * 0.1, p.y + r * 0.45);
    ctx.lineTo(p.x + r * 0.55, p.y - r * 0.4);
    ctx.stroke();
  } else {
    ctx.strokeStyle = MARKER_ERROR_COLOR;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = MARKER_ERROR_COLOR;
    ctx.fill();
  }
  if (withLabel) {
    ctx.font = '11px monospace';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(marker.code, p.x + r + 4, p.y + 4);
    ctx.fillStyle = marker.fixed ? MARKER_FIXED_COLOR : MARKER_ERROR_COLOR;
    ctx.fillText(marker.code, p.x + r + 4, p.y + 4);
  }
}

/**
 * Cheap things drawn over the (possibly cached) base on every frame: highlight halos, the clicked
 * entity, merged pieces, added items and the problem markers (a fixed size on screen).
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { scene, preview } = model;
  const bounds = visibleBounds(tf, vp);
  const inView = (index: number) => {
    const b = boxOf(scene, index);
    return (
      b.minX <= bounds.maxX &&
      b.maxX >= bounds.minX &&
      b.minY <= bounds.maxY &&
      b.maxY >= bounds.minY
    );
  };
  const shown = (index: number) => model.layerShown(effectiveLayer(scene, preview, index));

  setWorldTransform(ctx, scene, tf, vp);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (preview.merged.size > 0) {
    ctx.strokeStyle = MARKER_FIXED_COLOR;
    ctx.lineWidth = 3 / tf.scale;
    ctx.setLineDash([8 / tf.scale, 5 / tf.scale]);
    for (const index of preview.merged) {
      if (inView(index) && shown(index) && scene.view.entities[index]?.paths.length) {
        ctx.stroke(cache.get(index));
      }
    }
    ctx.setLineDash([]);
  }
  if (model.trench && model.trench.size > 0) {
    ctx.strokeStyle = TRENCH_COLOR;
    ctx.lineWidth = 4 / tf.scale;
    ctx.setLineDash([12 / tf.scale, 6 / tf.scale]);
    for (const index of model.trench.keys()) {
      if (inView(index) && shown(index) && scene.view.entities[index]?.paths.length) {
        ctx.stroke(cache.get(index));
      }
    }
    ctx.setLineDash([]);
  }
  for (const index of model.highlighted) {
    if (!shown(index) || !scene.view.entities[index]?.paths.length) continue;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = HIGHLIGHT_HALO;
    ctx.lineWidth = 10 / tf.scale;
    ctx.stroke(cache.get(index));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.5 / tf.scale;
    ctx.stroke(cache.get(index));
  }
  if (
    model.selected !== null &&
    shown(model.selected) &&
    scene.view.entities[model.selected]?.paths.length
  ) {
    ctx.strokeStyle = SELECTED_COLOR;
    ctx.lineWidth = 3 / tf.scale;
    ctx.stroke(cache.get(model.selected));
  }

  setScreenTransform(ctx, vp);
  for (const index of model.highlighted) {
    if (shown(index)) boxOutline(ctx, model, tf, vp, index, '#e65100');
  }
  if (model.selected !== null && shown(model.selected)) {
    boxOutline(ctx, model, tf, vp, model.selected, SELECTED_COLOR);
  }

  if (model.trench && model.trench.size > 0) drawTrenchLabels(ctx, model, tf, vp, inView, shown);

  for (const item of preview.extraItems) {
    if (!model.layerShown(item.layer)) continue;
    const p = toScreen(tf, vp, item.x, item.y);
    ctx.strokeStyle = paperColor(item.color);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.moveTo(p.x - 9, p.y);
    ctx.lineTo(p.x + 9, p.y);
    ctx.moveTo(p.x, p.y - 9);
    ctx.lineTo(p.x, p.y + 9);
    ctx.stroke();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const onScreen = model.markers.filter((marker) => {
    const p = toScreen(tf, vp, marker.x, marker.y);
    return p.x > -60 && p.y > -20 && p.x < vp.width + 200 && p.y < vp.height + 20;
  });
  const withLabel = onScreen.length <= MAX_MARKER_LABELS;
  for (const marker of onScreen) drawMarker(ctx, marker, tf, vp, withLabel);
}
