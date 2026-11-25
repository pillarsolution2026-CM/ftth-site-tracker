import { describe, expect, it } from 'vitest';
import { createProjectCrs } from '@ftth/geo';
import type { CadMapping } from '@ftth/shared';
import { applyAffine } from './affine';
import { drawingToLonLat, MAX_TILES, mercator, screenToMercator, tilesFor } from './osm-backdrop';
import type { ViewTransform } from './view-transform';

const mapping = (patch: Partial<CadMapping> = {}): CadMapping => ({
  cadFileId: '00000000-0000-4000-8000-000000000001',
  rules: [],
  crsEpsg: 32636,
  drawingUnit: 'm',
  metresPerUnit: '1',
  placement: null,
  version: 1,
  updatedById: null,
  updatedAt: '2026-11-24T00:00:00.000Z',
  ...patch,
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

// A point of Cairo in UTM 36N (metres).
const CAIRO = { x: 330000, y: 3330000 };

describe('drawingToLonLat', () => {
  it('needs a mapping', () => {
    expect(drawingToLonLat(undefined)).toBeNull();
    expect(drawingToLonLat(null)).toBeNull();
  });

  it('refuses a CRS that is not a UTM zone and a bad unit', () => {
    expect(drawingToLonLat(mapping({ crsEpsg: 4326 }))).toBeNull();
    expect(drawingToLonLat(mapping({ metresPerUnit: '0' }))).toBeNull();
  });

  it('as drawn in metres: the project CRS point itself', () => {
    const toLonLat = drawingToLonLat(mapping());
    const expected = createProjectCrs(32636).toWgs84(CAIRO);
    const got = toLonLat?.(CAIRO.x, CAIRO.y);
    expect(got?.lon).toBeCloseTo(expected.lon, 9);
    expect(got?.lat).toBeCloseTo(expected.lat, 9);
  });

  it('applies the unit and the placement move, as the build does', () => {
    const toLonLat = drawingToLonLat(
      mapping({
        metresPerUnit: '0.001',
        placement: {
          sourceCrs: 'project',
          points: [],
          fitScaleWithTwoPoints: false,
          adjust: { dx: 100, dy: -50, rotationDeg: 0, scale: 1, pivot: null },
        },
      }),
    );
    const expected = createProjectCrs(32636).toWgs84({ x: CAIRO.x + 100, y: CAIRO.y - 50 });
    const got = toLonLat?.(CAIRO.x * 1000, CAIRO.y * 1000);
    expect(got?.lon).toBeCloseTo(expected.lon, 9);
    expect(got?.lat).toBeCloseTo(expected.lat, 9);
  });
});

describe('mercator', () => {
  it('puts (0, 0) in the middle and the date line at the edges', () => {
    expect(mercator({ lon: 0, lat: 0 })).toEqual({ x: 0.5, y: 0.5 });
    expect(mercator({ lon: -180, lat: 0 }).x).toBe(0);
    expect(mercator({ lon: 90, lat: 45 }).y).toBeLessThan(0.5);
  });
});

describe('screen to tiles', () => {
  const size = { width: 800, height: 600 };
  // 1 drawing unit = 1 m, centred on Cairo, 1 m per screen pixel.
  const tf: ViewTransform = { cx: CAIRO.x, cy: CAIRO.y, scale: 1 };
  const toLonLat = must(drawingToLonLat(mapping()));

  it('fits an affine that sends the screen centre to the drawing centre', () => {
    const m = must(screenToMercator(tf, size, toLonLat));
    const centre = mercator(createProjectCrs(32636).toWgs84(CAIRO));
    const got = applyAffine(m, 400, 300);
    expect(got.x).toBeCloseTo(centre.x, 12);
    expect(got.y).toBeCloseTo(centre.y, 12);
  });

  it('chooses the zoom whose pixel is close to a screen pixel and covers the screen', () => {
    const m = must(screenToMercator(tf, size, toLonLat));
    const tiles = tilesFor(m, size);
    // ~1 m per pixel at latitude 30 is zoom 17.
    expect(new Set(tiles.map((tile) => tile.z))).toEqual(new Set([17]));
    expect(tiles.length).toBeGreaterThan(4);
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(tiles[0]?.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/17\/\d+\/\d+\.png$/);
    // The tile under the centre is placed under the centre.
    const centre = applyAffine(m, 400, 300);
    const n = 2 ** 17;
    const under = must(
      tiles.find(
        (tile) => tile.x === Math.floor(centre.x * n) && tile.y === Math.floor(centre.y * n),
      ),
    );
    const u = (centre.x * n - under.x) * 256;
    const v = (centre.y * n - under.y) * 256;
    const onScreen = applyAffine(under.transform, u, v);
    expect(onScreen.x).toBeCloseTo(400, 3);
    expect(onScreen.y).toBeCloseTo(300, 3);
  });

  it('takes a lower zoom rather than too many tiles', () => {
    const big = { width: 8000, height: 6000 };
    const m = must(screenToMercator(tf, big, toLonLat));
    expect(tilesFor(m, big).length).toBeLessThanOrEqual(MAX_TILES);
  });
});
