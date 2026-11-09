/**
 * Pure view maths of the drawing viewer (ADR-039). The view is the drawing point at the centre of
 * the canvas plus a scale (CSS pixels per drawing unit). Y points up in the drawing and down on the
 * screen, so every conversion flips Y.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewTransform {
  /** Drawing point shown at the centre of the canvas. */
  cx: number;
  cy: number;
  /** CSS pixels per drawing unit. */
  scale: number;
}

export interface ScaleLimits {
  min: number;
  max: number;
}

/** Zoom factor of the buttons and keys, per step. */
export const ZOOM_STEP = 1.5;
/** Wheel zoom: scale factor per wheel delta unit. */
export const WHEEL_ZOOM_BASE = 1.0015;

export function toScreen(tf: ViewTransform, size: Size, x: number, y: number) {
  return {
    x: (x - tf.cx) * tf.scale + size.width / 2,
    y: size.height / 2 - (y - tf.cy) * tf.scale,
  };
}

export function toWorld(tf: ViewTransform, size: Size, sx: number, sy: number) {
  return {
    x: (sx - size.width / 2) / tf.scale + tf.cx,
    y: (size.height / 2 - sy) / tf.scale + tf.cy,
  };
}

/** Drawing rectangle that is visible on the canvas. */
export function visibleBounds(tf: ViewTransform, size: Size): Bounds {
  const a = toWorld(tf, size, 0, size.height);
  const b = toWorld(tf, size, size.width, 0);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

/** Everything inside the canvas with a margin; a drawing of no extent gets scale 1. */
export function fitTransform(bounds: Bounds, size: Size, padding = 24): ViewTransform {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const availW = Math.max(1, size.width - padding * 2);
  const availH = Math.max(1, size.height - padding * 2);
  const scale = Math.min(w > 0 ? availW / w : Infinity, h > 0 ? availH / h : Infinity);
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

/** A square window `halfSize` drawing units each side of the centre fits the canvas. */
export function windowTransform(
  centerX: number,
  centerY: number,
  halfSize: number,
  size: Size,
): ViewTransform {
  const side = Math.max(1, Math.min(size.width, size.height));
  return { cx: centerX, cy: centerY, scale: side / (2 * Math.max(halfSize, Number.EPSILON)) };
}

export function scaleLimits(fit: ViewTransform): ScaleLimits {
  return { min: fit.scale / 20, max: fit.scale * 1_000_000 };
}

export const clampScale = (scale: number, limits: ScaleLimits) =>
  Math.min(limits.max, Math.max(limits.min, scale));

/** Zoom by `factor` keeping the drawing point under screen point (sx, sy) where it is. */
export function zoomAt(
  tf: ViewTransform,
  size: Size,
  sx: number,
  sy: number,
  factor: number,
  limits: ScaleLimits,
): ViewTransform {
  const scale = clampScale(tf.scale * factor, limits);
  const anchor = toWorld(tf, size, sx, sy);
  return {
    scale,
    cx: anchor.x - (sx - size.width / 2) / scale,
    cy: anchor.y + (sy - size.height / 2) / scale,
  };
}

/** The content follows the pointer: a drag of (dx, dy) screen pixels. */
export function panBy(tf: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...tf, cx: tf.cx - dx / tf.scale, cy: tf.cy + dy / tf.scale };
}

export const wheelFactor = (deltaY: number) => Math.pow(WHEEL_ZOOM_BASE, -deltaY);
