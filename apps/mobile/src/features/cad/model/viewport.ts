import { distance, distanceToSegment, type Point } from '@ftth/geo';
import type { FeatureType, OfflineFeature } from '@ftth/shared';

/**
 * The CAD screen's camera over project-CRS coordinates (metres, y north). Rotation is locked
 * (plan: "rotate مقفول"); the screen's y axis points down.
 */
export interface Viewport {
  centerX: number;
  centerY: number;
  metresPerPixel: number;
  widthPx: number;
  heightPx: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 1 mm to 5 km per pixel: from a manhole cover to a whole city. */
export const MIN_METRES_PER_PIXEL = 0.001;
export const MAX_METRES_PER_PIXEL = 5000;

const clampScale = (mpp: number): number =>
  Math.min(MAX_METRES_PER_PIXEL, Math.max(MIN_METRES_PER_PIXEL, mpp));

export function coordinatesOf(feature: OfflineFeature): readonly (readonly [number, number])[] {
  return feature.geometry.type === 'Point'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
}

export function boundsOf(features: readonly OfflineFeature[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const feature of features) {
    for (const [x, y] of coordinatesOf(feature)) {
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, x),
            minY: Math.min(bounds.minY, y),
            maxX: Math.max(bounds.maxX, x),
            maxY: Math.max(bounds.maxY, y),
          }
        : { minX: x, minY: y, maxX: x, maxY: y };
    }
  }
  return bounds;
}

export function fitBounds(
  bounds: Bounds,
  widthPx: number,
  heightPx: number,
  paddingPx = 24,
): Viewport {
  const usableW = Math.max(1, widthPx - 2 * paddingPx);
  const usableH = Math.max(1, heightPx - 2 * paddingPx);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    metresPerPixel: clampScale(Math.max(spanX / usableW, spanY / usableH)),
    widthPx,
    heightPx,
  };
}

export function toScreen(vp: Viewport, x: number, y: number): { sx: number; sy: number } {
  return {
    sx: vp.widthPx / 2 + (x - vp.centerX) / vp.metresPerPixel,
    sy: vp.heightPx / 2 - (y - vp.centerY) / vp.metresPerPixel,
  };
}

export function toWorld(vp: Viewport, sx: number, sy: number): Point {
  return {
    x: vp.centerX + (sx - vp.widthPx / 2) * vp.metresPerPixel,
    y: vp.centerY - (sy - vp.heightPx / 2) * vp.metresPerPixel,
  };
}

/** Moves the drawing with the finger by (dx, dy) pixels. */
export function pan(vp: Viewport, dxPx: number, dyPx: number): Viewport {
  return {
    ...vp,
    centerX: vp.centerX - dxPx * vp.metresPerPixel,
    centerY: vp.centerY + dyPx * vp.metresPerPixel,
  };
}

/** Zooms by `factor` (> 1 zooms in) keeping the world point under (focusX, focusY) fixed. */
export function zoomAt(vp: Viewport, factor: number, focusX: number, focusY: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return vp;
  const anchor = toWorld(vp, focusX, focusY);
  const scaled = { ...vp, metresPerPixel: clampScale(vp.metresPerPixel / factor) };
  const moved = toWorld(scaled, focusX, focusY);
  return {
    ...scaled,
    centerX: scaled.centerX + (anchor.x - moved.x),
    centerY: scaled.centerY + (anchor.y - moved.y),
  };
}

/** Distance in metres from `p` to the feature's geometry. */
export function distanceToFeature(feature: OfflineFeature, p: Point): number {
  if (feature.geometry.type === 'Point') {
    const [x, y] = feature.geometry.coordinates;
    return distance(p, { x, y });
  }
  const coords = feature.geometry.coordinates;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = coords[i - 1] ?? [0, 0];
    const [bx, by] = coords[i] ?? [0, 0];
    best = Math.min(best, distanceToSegment(p, { x: ax, y: ay }, { x: bx, y: by }));
  }
  return best;
}

/**
 * The feature under the crosshair (screen centre): nearest within `tolerancePx`; point features
 * win close calls against routes because they sit on top of them.
 */
export function pickAtCrosshair(
  features: readonly OfflineFeature[],
  vp: Viewport,
  visible: ReadonlySet<FeatureType>,
  tolerancePx = 22,
): OfflineFeature | null {
  const centre = { x: vp.centerX, y: vp.centerY };
  const tolerance = tolerancePx * vp.metresPerPixel;
  let best: { feature: OfflineFeature; score: number } | null = null;
  for (const feature of features) {
    if (!visible.has(feature.type)) continue;
    const d = distanceToFeature(feature, centre);
    if (d > tolerance) continue;
    const score = d + (feature.geometry.type === 'LineString' ? tolerance / 2 : 0);
    if (!best || score < best.score) best = { feature, score };
  }
  return best?.feature ?? null;
}

/** Features of the visible types whose bounds touch the screen (culling before drawing). */
export function visibleFeatures(
  features: readonly OfflineFeature[],
  vp: Viewport,
  visible: ReadonlySet<FeatureType>,
): OfflineFeature[] {
  const halfW = (vp.widthPx / 2) * vp.metresPerPixel;
  const halfH = (vp.heightPx / 2) * vp.metresPerPixel;
  return features.filter((feature) => {
    if (!visible.has(feature.type)) return false;
    const b = boundsOf([feature]);
    return (
      !!b &&
      b.maxX >= vp.centerX - halfW &&
      b.minX <= vp.centerX + halfW &&
      b.maxY >= vp.centerY - halfH &&
      b.minY <= vp.centerY + halfH
    );
  });
}

/** Easting/northing of the crosshair to the centimetre (shown LTR). */
export function formatEastingNorthing(vp: Viewport): { e: string; n: string } {
  return { e: vp.centerX.toFixed(2), n: vp.centerY.toFixed(2) };
}
