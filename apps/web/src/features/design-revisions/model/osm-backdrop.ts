import { createProjectCrs, solvePlacement, sourceToProject, type LonLat } from '@ftth/geo';
import type { CadMapping } from '@ftth/shared';
import { applyAffine, invert, type Affine } from './affine';
import { toWorld, type Size, type ViewTransform } from './view-transform';

/**
 * The OpenStreetMap background of the CAD screen (owner 2026-11-24). It is loaded only when the
 * user asks for it. Drawing point → project CRS (the file's unit and placement, as the build does)
 * → WGS84 (display only, rule 5) → Web Mercator tiles. On screen, the view is close to affine,
 * so one affine fitted at the screen centre places every tile.
 */

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_MAX_ZOOM = 19;
const TILE = 256;
/** The most tiles drawn at once; a bigger screen takes a lower zoom. */
export const MAX_TILES = 80;

/** Drawing point → Lon/Lat, or null when the file has no mapping (no CRS or unit yet). */
export function drawingToLonLat(
  mapping: CadMapping | null | undefined,
): ((x: number, y: number) => LonLat) | null {
  if (!mapping) return null;
  const metresPerUnit = Number(mapping.metresPerUnit);
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) return null;
  try {
    const crs = createProjectCrs(mapping.crsEpsg);
    const placement = mapping.placement;
    const solution = solvePlacement({
      projectEpsg: mapping.crsEpsg,
      metresPerUnit,
      sourceCrs: placement?.sourceCrs ?? 'project',
      points: placement?.points ?? [],
      fitScaleWithTwoPoints: placement?.fitScaleWithTwoPoints ?? false,
      adjust: placement?.adjust ?? { dx: 0, dy: 0, rotationDeg: 0, scale: 1, pivot: null },
    });
    const { total } = solution;
    const toSource = sourceToProject(
      placement?.sourceCrs ?? 'project',
      mapping.crsEpsg,
      metresPerUnit,
    );
    return (x, y) => {
      const p = toSource({ x, y });
      return crs.toWgs84({
        x: total.a * p.x - total.b * p.y + total.tx,
        y: total.b * p.x + total.a * p.y + total.ty,
      });
    };
  } catch {
    return null;
  }
}

/** Web Mercator, 0..1 across the world (x east, y south). */
export function mercator({ lon, lat }: LonLat): { x: number; y: number } {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return {
    x: (lon + 180) / 360,
    y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2,
  };
}

/** Screen pixel → Mercator (0..1), fitted at the centre of the screen. */
export function screenToMercator(
  tf: ViewTransform,
  size: Size,
  toLonLat: (x: number, y: number) => LonLat,
): Affine | null {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const d = Math.max(16, Math.min(size.width, size.height) / 4);
  const at = (sx: number, sy: number) => {
    const w = toWorld(tf, size, sx, sy);
    return mercator(toLonLat(w.x, w.y));
  };
  try {
    const m0 = at(cx, cy);
    const m1 = at(cx + d, cy);
    const m2 = at(cx, cy + d);
    const a = (m1.x - m0.x) / d;
    const b = (m1.y - m0.y) / d;
    const c = (m2.x - m0.x) / d;
    const e = (m2.y - m0.y) / d;
    const affine: Affine = [a, b, c, e, m0.x - a * cx - c * cy, m0.y - b * cx - e * cy];
    return affine.every(Number.isFinite) && a * e - b * c !== 0 ? affine : null;
  } catch {
    return null;
  }
}

export interface TileDraw {
  z: number;
  x: number;
  y: number;
  url: string;
  /** Canvas transform of the tile, its pixels (0..256) to screen pixels. */
  transform: Affine;
}

/** The tiles that cover the screen, at the zoom whose tile pixel is close to a screen pixel. */
export function tilesFor(toMercator: Affine, size: Size, dpr = 1): TileDraw[] {
  const [a, b, c, d] = toMercator;
  const perPixel = Math.sqrt(Math.abs(a * d - b * c));
  if (!(perPixel > 0)) return [];
  const corners = [
    [0, 0],
    [size.width, 0],
    [0, size.height],
    [size.width, size.height],
  ].map(([sx, sy]) => applyAffine(toMercator, sx ?? 0, sy ?? 0));
  const minX = Math.min(...corners.map((p) => p.x));
  const maxX = Math.max(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxY = Math.max(...corners.map((p) => p.y));
  let z = Math.round(Math.log2(1 / (TILE * perPixel * dpr)));
  z = Math.max(0, Math.min(OSM_MAX_ZOOM, z));
  const range = (zoom: number) => {
    const n = 2 ** zoom;
    return {
      n,
      x0: Math.floor(minX * n),
      x1: Math.floor(maxX * n),
      y0: Math.max(0, Math.floor(minY * n)),
      y1: Math.min(n - 1, Math.floor(maxY * n)),
    };
  };
  let r = range(z);
  while (z > 0 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > MAX_TILES) {
    z -= 1;
    r = range(z);
  }
  const back = invert(toMercator);
  const k = 1 / (TILE * r.n);
  const out: TileDraw[] = [];
  for (let ty = r.y0; ty <= r.y1; ty += 1) {
    for (let tx = r.x0; tx <= r.x1; tx += 1) {
      const wrapped = ((tx % r.n) + r.n) % r.n;
      const origin = applyAffine(back, tx / r.n, ty / r.n);
      out.push({
        z,
        x: wrapped,
        y: ty,
        url: OSM_TILE_URL.replace('{z}', String(z))
          .replace('{x}', String(wrapped))
          .replace('{y}', String(ty)),
        transform: [back[0] * k, back[1] * k, back[2] * k, back[3] * k, origin.x, origin.y],
      });
    }
  }
  return out;
}
