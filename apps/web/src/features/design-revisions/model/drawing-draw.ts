import type { DrawingViewEntity, HatchLinePattern } from '@ftth/shared';
import {
  angleOf,
  applyAffine,
  boxThrough,
  compose,
  IDENTITY,
  scaleOf,
  type Affine,
} from './affine';
import { isCrossing, type Band } from './canvas-edit';
import { LINETYPE_DASH, lineweightPx } from './cad-commands';
import {
  effectiveLayer,
  type DrawingPreview,
  type PreviewNote,
  type PreviewShape,
  type PreviewTextFormat,
} from './drawing-preview';
import type { ProblemMarker } from './drawing-hit';
import { boxOf, cullEntities, resolveColor, screenColor, type DrawingScene } from './drawing-scene';
import { linearDimension, type Pt } from './geometry';
import type { Grip } from './grips';
import { familiesOf, familyGap, islandLoops, patternSegments } from './hatch-patterns';
import { cellRects, cellTextHeight, styleOfRow } from './table';
import { textLength, wrapLines } from './text-tools';
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
const SELECTED_COLOR = '#4fc3f7';
/** The model space background, black as in AutoCAD (ADR-051). */
export const CANVAS_BG = '#000000';
/** AutoCAD's MText line spacing 1.0: 5/3 of the text height. */
const MTEXT_LINE_SPACING = 5 / 3;
/** Routes marked for trench (ADR-042): dashed purple, never colour alone (also a text label). */
export const TRENCH_COLOR = '#6a1b9a';

/** The type text next to a box (ADR-043), placed at the box's drawn centre. */
export interface BoxLabel {
  x: number;
  y: number;
  /** built: frozen on the draft; pending: chosen, not built yet; none: no type. */
  kind: 'built' | 'pending' | 'none';
  /** First line: the code (or the status word); then the cut description and a status note. */
  lines: readonly string[];
}

/** More labels than this on screen: only the first line of each is drawn. */
const COMPACT_BOX_LABELS = 40;
/** More than this on screen: none (they would be a smear), until the user zooms in. */
const MAX_BOX_LABELS = 400;
const BOX_LABEL_COLOR = '#1b5e20';
const BOX_LABEL_PENDING_COLOR = '#e65100';
const BOX_LABEL_NONE_COLOR = '#b71c1c';

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
  /** The type text of each box (ADR-043); undefined/empty: not shown. */
  boxLabels?: readonly BoxLabel[];
  /** Entities picked in the edit mode (ADR-047). */
  chosen?: ReadonlySet<number>;
  /** AutoCAD's grips of the picked objects (owner 2026-11-26). */
  grips?: readonly Grip[];
  /** Boxes of groups picked as one object, drawn dashed. */
  groupBoxes?: readonly { minX: number; minY: number; maxX: number; maxY: number }[];
  /** The grip under the pointer (AutoCAD's hover colour). */
  hoverGrip?: Grip | null;
  /** The hot grip of a grip STRETCH (red). */
  hotGrip?: Grip | null;
  /** The selection box being dragged in the edit mode, in drawing coordinates. */
  band?: Band | null;
  /** Picked entities shown where a move / turn in progress would put them (ADR-047). */
  ghost?: { indexes: readonly number[]; step: Affine } | null;
  /** The line / polyline / mirror line being drawn (ADR-050): fixed points, then the pointer. */
  sketch?: { points: readonly { x: number; y: number }[]; closed: boolean } | null;
  /** Layer index → colour the user chose for the screen (ADR-051; not saved). */
  layerColor?: ReadonlyMap<number, string>;
  /** Height of dimension and leader texts, drawing units. */
  noteHeight?: number;
  /** Locked layers drawn faded (AutoCAD's locked layer fading); undefined: not faded. */
  lockedFade?: { layers: ReadonlySet<number>; alpha: number };
  /** Objects isolated / hidden on the screen (AutoCAD's ISOLATEOBJECTS); undefined: all shown. */
  objectShown?: (index: number) => boolean;
  /** OpenStreetMap is shown under the drawing: the background is left clear (owner 2026-11-24). */
  mapBehind?: boolean;
  /** LWDISPLAY (status bar): false draws every line one pixel wide; undefined: at its weight. */
  lineweights?: boolean;
}

/** The colour an entity is drawn in now: its style, else its own, else its layer's (ADR-051). */
function colorOf(model: DrawModel, index: number): string {
  const { scene, preview } = model;
  const entity = scene.view.entities[index] as DrawingViewEntity;
  const styled = preview.styleOf.get(index)?.color;
  if (styled) return screenColor(styled);
  const layer = effectiveLayer(scene, preview, index);
  const moved = preview.layerOf.has(index);
  const override = model.layerColor?.get(layer);
  if (override && (moved || entity.color === null)) return screenColor(override);
  return screenColor(resolveColor(entity, scene.view.layers, layer, moved));
}

/** Colour of a layer (by index) on screen: the user's choice, else the drawing's. */
function layerColorOf(model: DrawModel, layer: number, fallback: string): string {
  return screenColor(model.layerColor?.get(layer) ?? fallback);
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

/**
 * A text with a format (set_text_format; ADR-055 part 7): its mask first (the background, or a
 * colour), then the text stretched to its width factor, in lines when it is a wrapped MText.
 */
function fillFormattedText(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  text: { x: number; y: number; height: number; rotation: number; text: string },
  format: PreviewTextFormat,
) {
  const px = text.height * tf.scale;
  if (px < MIN_TEXT_PX || px > 5000) return;
  const lines =
    format.mtext && format.wrap !== null
      ? wrapLines(text.text, text.height, format.widthFactor, format.wrap)
      : [text.text];
  const step = px * MTEXT_LINE_SPACING;
  const p = toScreen(tf, vp, text.x, text.y);
  const fill = ctx.fillStyle;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (text.rotation !== 0) ctx.rotate((-text.rotation * Math.PI) / 180);
  ctx.font = `${px * TEXT_FONT_FACTOR}px sans-serif`;
  const widths = lines.map((line) => textLength(line, text.height, format.widthFactor) * tf.scale);
  if (format.mask) {
    const off = format.mask.offset * px;
    const wide = Math.max(...widths, 0);
    ctx.fillStyle = format.mask.color ?? (model.mapBehind ? '#000000' : CANVAS_BG);
    ctx.fillRect(-off, -px - off, wide + 2 * off, px + (lines.length - 1) * step + 2 * off);
    ctx.fillStyle = fill;
  }
  lines.forEach((line, i) => {
    const measured = ctx.measureText(line).width;
    const target = widths[i] ?? measured;
    ctx.save();
    ctx.translate(0, i * step);
    // Drawn exactly as long as the screen reckons the text (TEXTFIT works on that length).
    if (format.widthFactor !== null && measured > 0) ctx.scale(target / measured, 1);
    ctx.fillText(line, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

/** Tables of the page (add_table; owner 2026-11-26): the grid and the cell texts. */
function drawTables(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { tables } = model.preview;
  if (tables.length === 0) return;
  setScreenTransform(ctx, vp);
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  for (const table of tables) {
    if (!model.layerShown(table.layer)) continue;
    const color = layerColorOf(model, table.layer, table.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const cell of cellRects(table)) {
      const a = toScreen(tf, vp, cell.x0, cell.y0);
      const b = toScreen(tf, vp, cell.x1, cell.y1);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      const value = table.cells[cell.row]?.[cell.col] ?? '';
      const px = cellTextHeight(styleOfRow(table.styles, cell.row), table.height) * tf.scale;
      if (value === '' || px < MIN_TEXT_PX || px > 5000) continue;
      ctx.font = `${px * TEXT_FONT_FACTOR}px sans-serif`;
      ctx.fillText(value, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x));
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** The drawing itself: entity strokes, then texts, on black. Heavy; redraw only on change. */
export function drawBase(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { scene, preview } = model;
  const { entities } = scene.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (model.mapBehind) ctx.clearRect(0, 0, vp.width * vp.dpr, vp.height * vp.dpr);
  else {
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, vp.width * vp.dpr, vp.height * vp.dpr);
  }

  const candidates = cullEntities(scene, visibleBounds(tf, vp));
  // Moved entities are culled by where they were drawn: add them so they show where they are now.
  if (preview.transformOf.size > 0) {
    const seen = new Set(candidates);
    for (const index of preview.transformOf.keys()) if (!seen.has(index)) candidates.push(index);
  }
  const shown: number[] = [];
  for (const index of candidates) {
    if (preview.erased.has(index)) continue;
    if (model.objectShown && !model.objectShown(index)) continue;
    if (model.layerShown(effectiveLayer(scene, preview, index))) shown.push(index);
  }
  // Draw order (set_order): lowest first; the file's order otherwise (a stable sort).
  if (preview.orderOf.size > 0) {
    const order = preview.orderOf;
    shown.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  // Hatches, gradients, donuts and construction lines lie under the drawing, as AutoCAD's.
  drawShapes(ctx, model, tf, vp, 'under');

  setWorldTransform(ctx, scene, tf, vp);
  ctx.lineWidth = 1 / tf.scale;
  ctx.lineJoin = 'round';
  let current = '';
  const texted: number[] = [];
  const styled: number[] = [];
  const faded: number[] = [];
  const fade = model.lockedFade;
  const isFaded = (index: number) =>
    fade !== undefined && fade.layers.has(effectiveLayer(scene, preview, index));
  for (const index of shown) {
    const entity = entities[index] as DrawingViewEntity;
    if (entity.texts.length > 0) texted.push(index);
    if (entity.paths.length === 0) continue;
    if (isFaded(index)) {
      faded.push(index);
      continue;
    }
    if (preview.styleOf.has(index)) {
      styled.push(index);
      continue;
    }
    const box = boxOf(scene, index);
    if (
      !preview.curveOf.has(index) &&
      (box.maxX - box.minX) * tf.scale < MIN_SHAPE_PX &&
      (box.maxY - box.minY) * tf.scale < MIN_SHAPE_PX
    ) {
      continue;
    }
    const color = colorOf(model, index);
    if (color !== current) {
      ctx.strokeStyle = color;
      current = color;
    }
    strokeEntity(ctx, model, cache, index);
  }
  // Locked layer fading: faded strokes of the locked layers.
  if (fade && faded.length > 0) {
    ctx.globalAlpha = fade.alpha;
    for (const index of faded) {
      ctx.strokeStyle = colorOf(model, index);
      strokeEntity(ctx, model, cache, index);
    }
    ctx.globalAlpha = 1;
  }
  // Line types and weights (set_style; ADR-051): dashes and widths in screen pixels.
  for (const index of styled) {
    const style = preview.styleOf.get(index);
    const weight = style?.lineweight ?? null;
    ctx.strokeStyle = colorOf(model, index);
    ctx.lineWidth =
      (weight !== null && model.lineweights !== false ? lineweightPx(weight) : 1) / tf.scale;
    ctx.setLineDash(LINETYPE_DASH[style?.linetype ?? 'continuous'].map((v) => v / tf.scale));
    strokeEntity(ctx, model, cache, index);
  }
  ctx.setLineDash([]);
  ctx.lineWidth = 1 / tf.scale;

  setScreenTransform(ctx, vp);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  current = '';
  for (const index of texted) {
    const entity = entities[index] as DrawingViewEntity;
    const color = colorOf(model, index);
    if (color !== current) {
      ctx.fillStyle = color;
      current = color;
    }
    const replaced = preview.textOf.get(index);
    const turned = preview.transformOf.get(index);
    ctx.globalAlpha = isFaded(index) && fade ? fade.alpha : 1;
    const format = preview.textFormatOf.get(index);
    entity.texts.forEach((text, i) => {
      const at = turned ? applyAffine(turned, text.x, text.y) : text;
      if (i === 0 && format) {
        fillFormattedText(
          ctx,
          model,
          tf,
          vp,
          {
            x: at.x,
            y: at.y,
            height: text.height * (turned ? scaleOf(turned) : 1),
            rotation: text.rotation + (turned ? angleOf(turned) : 0),
            text: replaced ?? text.text,
          },
          format,
        );
        return;
      }
      fillTextAt(
        ctx,
        tf,
        vp,
        at.x,
        at.y,
        text.height * (turned ? scaleOf(turned) : 1),
        text.rotation + (turned ? angleOf(turned) : 0),
        i === 0 && replaced !== undefined
          ? replaced
          : (preview.attrOf.get(index)?.get(text.text) ?? text.text),
      );
    });
  }
  ctx.globalAlpha = 1;
  for (const extra of preview.extraTexts) {
    if (!model.layerShown(extra.layer)) continue;
    ctx.fillStyle = layerColorOf(model, extra.layer, extra.color);
    fillTextAt(ctx, tf, vp, extra.x, extra.y, extra.height, 0, extra.text);
  }
  // A wipeout hides what is under it with the background.
  drawShapes(ctx, model, tf, vp, 'over');
  drawTables(ctx, model, tf, vp);
  drawAdded(ctx, model, cache, tf, vp);
}

/** Under this spacing on screen (px) a pattern is shown as a light solid fill. */
const MIN_HATCH_PX = 3;

/** Shapes of the page (add_shape; owner 2026-11-24), in screen pixels; screen only. */
function drawShapes(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  pass: 'under' | 'over',
): void {
  const { shapes } = model.preview;
  if (shapes.length === 0) return;
  setScreenTransform(ctx, vp);
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  for (const shape of shapes) {
    if (shapePass(shape) !== pass || !model.layerShown(shape.layer)) continue;
    const color = shape.color ?? layerColorOf(model, shape.layer, shape.layerColor);
    ctx.save();
    drawShape(ctx, model, tf, vp, shape, color);
    ctx.restore();
  }
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  shape: PreviewShape,
  color: string,
): void {
  const screen = shape.points.map((p) => toScreen(tf, vp, p[0], p[1]));
  const outline = () => {
    ctx.beginPath();
    screen.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  };
  const [first, second] = screen;
  if (!first) return;
  switch (shape.shape) {
    case 'wipeout':
      outline();
      ctx.fillStyle = model.mapBehind ? '#000000' : CANVAS_BG;
      ctx.fill();
      return;
    case 'donut': {
      const outer = ((shape.outer ?? 0) / 2) * tf.scale;
      const inner = ((shape.inner ?? 0) / 2) * tf.scale;
      ctx.beginPath();
      ctx.arc(first.x, first.y, Math.max(outer, 0.5), 0, Math.PI * 2);
      if (inner > 0) ctx.arc(first.x, first.y, inner, 0, Math.PI * 2, true);
      ctx.fillStyle = color;
      ctx.fill('evenodd');
      return;
    }
    case 'xline':
    case 'ray': {
      if (!second) return;
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const l = Math.hypot(dx, dy);
      if (l === 0) return;
      const far = (vp.width + vp.height) * 4;
      ctx.beginPath();
      const back = shape.shape === 'xline' ? far : 0;
      ctx.moveTo(first.x - (dx / l) * back, first.y - (dy / l) * back);
      ctx.lineTo(first.x + (dx / l) * far, first.y + (dy / l) * far);
      ctx.strokeStyle = color;
      ctx.stroke();
      return;
    }
    case 'gradient':
    case 'hatch':
      drawFill(ctx, model, tf, vp, shape, color);
      return;
  }
}

/**
 * Where a shape is drawn (AutoCAD's HPDRAWORDER): a hatch behind its boundary or at the back lies
 * under the drawing; one in front, above or of no order on top; wipeouts on top; donuts and
 * construction lines under, as before.
 */
export function shapePass(shape: PreviewShape): 'under' | 'over' {
  if (shape.shape === 'wipeout') return 'over';
  if (shape.shape === 'hatch' || shape.shape === 'gradient') {
    return shape.drawOrder === 'behind' || shape.drawOrder === 'back' ? 'under' : 'over';
  }
  return 'under';
}

/** A hatch or gradient (ADR-055 part 8): its loops by island detection, background, pattern. */
function drawFill(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  shape: PreviewShape,
  color: string,
): void {
  const { loops, rule } = islandLoops([shape.points, ...shape.loops], shape.island);
  const screenLoops = loops.map((loop) => loop.map((p) => toScreen(tf, vp, p[0], p[1])));
  const outline = () => {
    ctx.beginPath();
    for (const loop of screenLoops) {
      loop.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
    }
  };
  const all = screenLoops.flat();
  if (all.length === 0) return;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  ctx.globalAlpha = 1 - shape.transparency / 100;
  if (shape.shape === 'gradient') {
    const c2 = shape.color2 ?? '#ffffff';
    const name = shape.pattern ?? 'GR_LINEAR';
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const half = Math.hypot(maxX - cx, maxY - cy) || 1;
    const t = (-shape.angle * Math.PI) / 180;
    const radial = name.includes('SPH') || name.includes('HEM');
    const g = radial
      ? ctx.createRadialGradient(
          cx,
          name.includes('HEM') ? maxY : cy,
          0,
          cx,
          name.includes('HEM') ? maxY : cy,
          half * (name.includes('HEM') ? 2 : 1),
        )
      : ctx.createLinearGradient(
          cx - half * Math.cos(t),
          cy - half * Math.sin(t),
          cx + half * Math.cos(t),
          cy + half * Math.sin(t),
        );
    const inverse = name.includes('INV');
    const [a, b] = inverse ? [c2, color] : [color, c2];
    if (name.includes('CYL')) {
      g.addColorStop(0, a);
      g.addColorStop(0.5, b);
      g.addColorStop(1, a);
    } else if (radial) {
      g.addColorStop(0, b);
      g.addColorStop(1, a);
    } else if (name.includes('CUR')) {
      g.addColorStop(0, a);
      g.addColorStop(0.75, b);
      g.addColorStop(1, b);
    } else {
      g.addColorStop(0, a);
      g.addColorStop(1, b);
    }
    outline();
    ctx.fillStyle = g;
    ctx.fill(rule);
    return;
  }
  if (shape.background) {
    outline();
    ctx.fillStyle = shape.background;
    ctx.fill(rule);
  }
  const pattern = (shape.pattern ?? 'ANSI31') as HatchLinePattern;
  const families = familiesOf(pattern, shape.scale, shape.double);
  const finest = Math.min(
    ...families.map((f) => familyGap(f) * (pattern === 'USER' ? 1 : shape.scale)),
  );
  if (pattern === 'SOLID' || families.length === 0 || finest * tf.scale < MIN_HATCH_PX) {
    // Too fine to draw line by line: a light fill, as a pattern seen from far.
    ctx.globalAlpha *= pattern === 'SOLID' ? 1 : 0.35;
    outline();
    ctx.fillStyle = color;
    ctx.fill(rule);
    return;
  }
  // The pattern over what is on the screen of the hatch, clipped to its loops.
  const view = visibleBounds(tf, vp);
  const world = shape.points.concat(...shape.loops);
  const box = {
    minX: Math.max(view.minX, Math.min(...world.map((p) => p[0]))),
    minY: Math.max(view.minY, Math.min(...world.map((p) => p[1]))),
    maxX: Math.min(view.maxX, Math.max(...world.map((p) => p[0]))),
    maxY: Math.min(view.maxY, Math.max(...world.map((p) => p[1]))),
  };
  if (box.minX > box.maxX || box.minY > box.maxY) return;
  const segments = patternSegments(families, {
    angle: shape.angle,
    scale: pattern === 'USER' ? 1 : shape.scale,
    origin: shape.origin ?? [0, 0],
    box,
  });
  outline();
  ctx.clip(rule);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (!segments) {
    ctx.globalAlpha *= 0.35;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    return;
  }
  ctx.beginPath();
  for (const { a, b } of segments) {
    const p = toScreen(tf, vp, a[0], a[1]);
    const q = toScreen(tf, vp, b[0], b[1]);
    if (p.x === q.x && p.y === q.y) {
      ctx.rect(p.x - 0.6, p.y - 0.6, 1.2, 1.2);
      continue;
    }
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
}

/** Copies and lines added on the page (ADR-050), in their layers' colours. */
function drawAdded(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { scene, preview } = model;
  const { copies, extraCurves, notes } = preview;
  if (copies.length === 0 && extraCurves.length === 0 && notes.length === 0) return;
  const { entities } = scene.view;
  setWorldTransform(ctx, scene, tf, vp);
  ctx.lineWidth = 1 / tf.scale;
  const copyLayer = (copy: { index: number; layer?: number }) =>
    copy.layer ?? effectiveLayer(scene, preview, copy.index);
  const copyColor = (copy: { index: number; layer?: number }) =>
    copy.layer === undefined
      ? colorOf(model, copy.index)
      : layerColorOf(model, copy.layer, scene.view.layers[copy.layer]?.color ?? '#ffffff');
  for (const copy of preview.copies) {
    const entity = entities[copy.index];
    if (!entity || !model.layerShown(copyLayer(copy))) continue;
    ctx.strokeStyle = copyColor(copy);
    if (entity.paths.length) strokeWith(ctx, model, cache, copy.index, copy.transform);
  }
  const { x: ox, y: oy } = scene.origin;
  for (const curve of preview.extraCurves) {
    if (!model.layerShown(curve.layer)) continue;
    ctx.strokeStyle = layerColorOf(model, curve.layer, curve.color);
    ctx.beginPath();
    for (let i = 0; i + 1 < curve.path.length; i += 2) {
      const x = (curve.path[i] as number) - ox;
      const y = (curve.path[i + 1] as number) - oy;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (curve.closed) ctx.closePath();
    ctx.stroke();
  }
  setScreenTransform(ctx, vp);
  for (const copy of preview.copies) {
    const entity = entities[copy.index];
    if (!entity?.texts.length || !model.layerShown(copyLayer(copy))) {
      continue;
    }
    ctx.fillStyle = copyColor(copy);
    for (const text of entity.texts) {
      const at = applyAffine(copy.transform, text.x, text.y);
      fillTextAt(
        ctx,
        tf,
        vp,
        at.x,
        at.y,
        text.height * scaleOf(copy.transform),
        text.rotation + angleOf(copy.transform),
        text.text,
      );
    }
  }
  for (const note of notes) {
    if (model.layerShown(note.layer)) drawNote(ctx, model, tf, vp, note);
  }
}

/** A dimension or leader (add_note; ADR-051) as AutoCAD draws them; screen only. */
function drawNote(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  tf: ViewTransform,
  vp: Viewport,
  note: PreviewNote,
): void {
  const color = layerColorOf(model, note.layer, note.color);
  const height = model.noteHeight ?? 2.5;
  const fontPx = Math.max(9, height * tf.scale * TEXT_FONT_FACTOR);
  const s = (p: Pt) => toScreen(tf, vp, p[0], p[1]);
  setScreenTransform(ctx, vp);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  const segment = (a: Pt, b: Pt) => {
    const p = s(a);
    const q = s(b);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  };
  const arrow = (tip: Pt, from: Pt) => {
    const p = s(tip);
    const q = s(from);
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    const size = Math.max(5, Math.min(12, fontPx * 0.8));
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + size * Math.cos(angle - 0.3), p.y + size * Math.sin(angle - 0.3));
    ctx.lineTo(p.x + size * Math.cos(angle + 0.3), p.y + size * Math.sin(angle + 0.3));
    ctx.closePath();
    ctx.fill();
  };
  const points = note.points.map((p) => [p[0], p[1]] as Pt);
  const [a, b, c] = points;
  ctx.font = `${fontPx}px sans-serif`;
  if (note.note === 'dimension' && a && b && c) {
    const dim = linearDimension(a, b, c);
    segment(...dim.extensions[0]);
    segment(...dim.extensions[1]);
    segment(...dim.line);
    arrow(dim.line[0], dim.line[1]);
    arrow(dim.line[1], dim.line[0]);
    const at = s(dim.middle);
    ctx.save();
    ctx.translate(at.x, at.y);
    if (dim.direction === 'vertical') ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(note.text ?? dim.value.toFixed(2), 0, -3);
    ctx.restore();
    ctx.textAlign = 'left';
    return;
  }
  for (let i = 0; i + 1 < points.length; i++) segment(points[i] as Pt, points[i + 1] as Pt);
  if (a && b) arrow(a, b);
  const last = points[points.length - 1];
  if (last && note.text) {
    const at = s(last);
    ctx.fillText(note.text, at.x + 4, at.y + 4);
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
  const box = shownBox(model, index);
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

/** The type text under each box: code, description, and the status for «not built» / «no type». */
function drawBoxLabels(
  ctx: CanvasRenderingContext2D,
  labels: readonly BoxLabel[],
  tf: ViewTransform,
  vp: Viewport,
) {
  const visible: { label: BoxLabel; sx: number; sy: number }[] = [];
  for (const label of labels) {
    const p = toScreen(tf, vp, label.x, label.y);
    if (p.x < -120 || p.y < -40 || p.x > vp.width + 120 || p.y > vp.height + 40) continue;
    visible.push({ label, sx: p.x, sy: p.y });
  }
  if (visible.length === 0 || visible.length > MAX_BOX_LABELS) return;
  const compact = visible.length > COMPACT_BOX_LABELS;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const LINE = 14;
  for (const { label, sx, sy } of visible) {
    const lines = compact ? label.lines.slice(0, 1) : label.lines;
    const color =
      label.kind === 'built'
        ? BOX_LABEL_COLOR
        : label.kind === 'pending'
          ? BOX_LABEL_PENDING_COLOR
          : BOX_LABEL_NONE_COLOR;
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 10;
    const height = lines.length * LINE + 4;
    const top = sy + 12;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sx - width / 2, top, width, height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash(label.kind === 'built' ? [] : [4, 3]);
    ctx.strokeRect(sx - width / 2, top, width, height);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    lines.forEach((line, index) => ctx.fillText(line, sx, top + 2 + LINE / 2 + index * LINE));
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
  const shown = (index: number) =>
    (!model.objectShown || model.objectShown(index)) &&
    model.layerShown(effectiveLayer(scene, preview, index));

  setWorldTransform(ctx, scene, tf, vp);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (preview.merged.size > 0) {
    ctx.strokeStyle = MARKER_FIXED_COLOR;
    ctx.lineWidth = 3 / tf.scale;
    ctx.setLineDash([8 / tf.scale, 5 / tf.scale]);
    for (const index of preview.merged) {
      if (inView(index) && shown(index) && scene.view.entities[index]?.paths.length) {
        strokeEntity(ctx, model, cache, index);
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
        strokeEntity(ctx, model, cache, index);
      }
    }
    ctx.setLineDash([]);
  }
  for (const index of model.highlighted) {
    if (!shown(index) || !scene.view.entities[index]?.paths.length) continue;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = HIGHLIGHT_HALO;
    ctx.lineWidth = 10 / tf.scale;
    strokeEntity(ctx, model, cache, index);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 / tf.scale;
    strokeEntity(ctx, model, cache, index);
  }
  if (
    model.selected !== null &&
    shown(model.selected) &&
    scene.view.entities[model.selected]?.paths.length
  ) {
    ctx.strokeStyle = SELECTED_COLOR;
    ctx.lineWidth = 3 / tf.scale;
    strokeEntity(ctx, model, cache, model.selected);
  }

  setScreenTransform(ctx, vp);
  for (const index of model.highlighted) {
    if (shown(index)) boxOutline(ctx, model, tf, vp, index, '#e65100');
  }
  if (model.selected !== null && shown(model.selected)) {
    boxOutline(ctx, model, tf, vp, model.selected, SELECTED_COLOR);
  }
  if ((model.chosen && model.chosen.size > 0) || model.grips?.length)
    drawChosen(ctx, model, cache, tf, vp);
  if (model.band) drawBand(ctx, model.band, tf, vp);
  if (model.ghost) drawGhost(ctx, model, cache, tf, vp, model.ghost);
  if (model.sketch && model.sketch.points.length > 0) drawSketch(ctx, model.sketch, tf, vp);

  if (model.trench && model.trench.size > 0) drawTrenchLabels(ctx, model, tf, vp, inView, shown);
  if (model.boxLabels && model.boxLabels.length > 0) drawBoxLabels(ctx, model.boxLabels, tf, vp);

  for (const item of preview.extraItems) {
    if (!model.layerShown(item.layer)) continue;
    const p = toScreen(tf, vp, item.x, item.y);
    ctx.strokeStyle = layerColorOf(model, item.layer, item.color);
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

/** AutoCAD shows picked objects dashed and light, with blue grips. */
const CHOSEN_COLOR = '#5a9bff';
/** GRIPCOLOR 150, GRIPHOVER 11, GRIPHOT 12 (AutoCAD's defaults). */
export const GRIP_COLOR = '#007fff';
export const GRIP_HOVER_COLOR = '#ff7f7f';
export const GRIP_HOT_COLOR = '#ff0000';
/** Half the side of a grip on screen (GRIPSIZE 5 at 96 dpi). */
export const GRIP_HALF_PX = 4.5;

const sameGrip = (a: Grip | null | undefined, b: Grip) =>
  a !== null &&
  a !== undefined &&
  a.index === b.index &&
  a.kind === b.kind &&
  a.vertex === b.vertex &&
  a.x === b.x &&
  a.y === b.y;

/** Picked items as AutoCAD shows them: dashed, with AutoCAD's grips of each object. */
function drawChosen(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const { scene } = model;
  const chosen = model.chosen ?? new Set<number>();
  setWorldTransform(ctx, scene, tf, vp);
  ctx.strokeStyle = CHOSEN_COLOR;
  ctx.lineWidth = 2 / tf.scale;
  ctx.setLineDash([6 / tf.scale, 4 / tf.scale]);
  for (const index of chosen) {
    if (scene.view.entities[index]?.paths.length) strokeEntity(ctx, model, cache, index);
  }
  ctx.setLineDash([]);
  setScreenTransform(ctx, vp);
  ctx.strokeStyle = CHOSEN_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const box of model.groupBoxes ?? []) {
    const a = toScreen(tf, vp, box.minX, box.maxY);
    const b = toScreen(tf, vp, box.maxX, box.minY);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  ctx.setLineDash([]);
  for (const grip of model.grips ?? []) {
    const p = toScreen(tf, vp, grip.x, grip.y);
    ctx.fillStyle = sameGrip(model.hotGrip, grip)
      ? GRIP_HOT_COLOR
      : sameGrip(model.hoverGrip, grip)
        ? GRIP_HOVER_COLOR
        : GRIP_COLOR;
    // A polyline's segment grip is a thin rectangle, the others squares (AutoCAD).
    const w = grip.kind === 'segment' ? GRIP_HALF_PX * 1.4 : GRIP_HALF_PX;
    const h = grip.kind === 'segment' ? GRIP_HALF_PX * 0.6 : GRIP_HALF_PX;
    ctx.fillRect(p.x - w, p.y - h, w * 2, h * 2);
  }
}

/** Window (to the right): solid blue; crossing (to the left): dashed green, like AutoCAD. */
function drawBand(
  ctx: CanvasRenderingContext2D,
  band: Band,
  tf: ViewTransform,
  vp: Viewport,
): void {
  const a = toScreen(tf, vp, band.x0, band.y0);
  const b = toScreen(tf, vp, band.x1, band.y1);
  const crossing = isCrossing(band);
  setScreenTransform(ctx, vp);
  ctx.fillStyle = crossing ? 'rgba(46, 125, 50, 0.12)' : 'rgba(0, 87, 217, 0.12)';
  ctx.strokeStyle = crossing ? '#2e7d32' : CHOSEN_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash(crossing ? [6, 4] : []);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/** An entity's box where the preview draws it. */
function shownBox(model: DrawModel, index: number) {
  const box = boxOf(model.scene, index);
  const moved = model.preview.transformOf.get(index);
  return moved ? boxThrough(moved, box) : box;
}

/** Strokes an entity where the preview puts it (ADR-047); the world transform must be set. */
function strokeEntity(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  index: number,
  extra?: Affine,
): void {
  const replaced = model.preview.curveOf.get(index);
  if (replaced) {
    strokePoints(ctx, model, replaced.points, replaced.closed, extra);
    return;
  }
  const saved = model.preview.transformOf.get(index);
  const t = extra ? compose(saved ?? IDENTITY, extra) : saved;
  if (!t) {
    ctx.stroke(cache.get(index));
    return;
  }
  strokeWith(ctx, model, cache, index, t);
}

/** Strokes drawing points (a curve with new points, ADR-051); the world transform must be set. */
function strokePoints(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  points: readonly (readonly [number, number])[],
  closed: boolean,
  extra?: Affine,
): void {
  const { x: ox, y: oy } = model.scene.origin;
  ctx.beginPath();
  points.forEach((p, i) => {
    const q = extra ? applyAffine(extra, p[0], p[1]) : { x: p[0], y: p[1] };
    if (i === 0) ctx.moveTo(q.x - ox, q.y - oy);
    else ctx.lineTo(q.x - ox, q.y - oy);
  });
  if (closed) ctx.closePath();
  ctx.stroke();
}

/** Strokes an entity with exactly this transform (world transform set). */
function strokeWith(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  index: number,
  t: Affine,
): void {
  // Paths are relative to the scene origin o: local' = A·(local + o) + t − o.
  const { x: ox, y: oy } = model.scene.origin;
  ctx.save();
  ctx.transform(
    t[0],
    t[1],
    t[2],
    t[3],
    t[0] * ox + t[2] * oy + t[4] - ox,
    t[1] * ox + t[3] * oy + t[5] - oy,
  );
  ctx.stroke(cache.get(index));
  ctx.restore();
}

/** The picked entities, dashed, where the move / turn in progress would put them. */
function drawGhost(
  ctx: CanvasRenderingContext2D,
  model: DrawModel,
  cache: PathCache,
  tf: ViewTransform,
  vp: Viewport,
  ghost: { indexes: readonly number[]; step: Affine },
): void {
  const { scene } = model;
  setWorldTransform(ctx, scene, tf, vp);
  ctx.strokeStyle = CHOSEN_COLOR;
  ctx.lineWidth = 2 / tf.scale;
  ctx.setLineDash([6 / tf.scale, 4 / tf.scale]);
  for (const index of ghost.indexes) {
    if (scene.view.entities[index]?.paths.length)
      strokeEntity(ctx, model, cache, index, ghost.step);
  }
  ctx.setLineDash([]);
  setScreenTransform(ctx, vp);
  for (const index of ghost.indexes) {
    const box = boxThrough(ghost.step, shownBox(model, index));
    const a = toScreen(tf, vp, box.minX, box.maxY);
    const b = toScreen(tf, vp, box.maxX, box.minY);
    ctx.strokeStyle = CHOSEN_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.x, a.y, Math.max(6, b.x - a.x), Math.max(6, b.y - a.y));
  }
  ctx.setLineDash([]);
}

/** The line being drawn: fixed points solid, the segment to the pointer dashed (ADR-050). */
function drawSketch(
  ctx: CanvasRenderingContext2D,
  sketch: { points: readonly { x: number; y: number }[]; closed: boolean },
  tf: ViewTransform,
  vp: Viewport,
): void {
  setScreenTransform(ctx, vp);
  const pts = sketch.points.map((p) => toScreen(tf, vp, p.x, p.y));
  // AutoCAD's rubber band: thin and light on black.
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (sketch.closed && pts.length > 2) ctx.closePath();
  ctx.stroke();
  for (const p of pts) {
    ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
  }
}
