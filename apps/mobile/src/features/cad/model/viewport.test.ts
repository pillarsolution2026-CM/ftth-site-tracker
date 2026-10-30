import type { FeatureType, OfflineFeature } from '@ftth/shared';
import {
  boundsOf,
  fitBounds,
  formatEastingNorthing,
  pan,
  pickAtCrosshair,
  toScreen,
  toWorld,
  visibleFeatures,
  zoomAt,
  type Viewport,
} from './viewport';

const E = 330_000;
const N = 3_340_000;
const route: OfflineFeature = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'route',
  code: null,
  layer: 'N_DUC_CBL',
  geometry: {
    type: 'LineString',
    coordinates: [
      [E, N],
      [E + 100, N],
    ],
  },
  lengthM: '100',
};
const box: OfflineFeature = {
  id: '00000000-0000-4000-8000-000000000002',
  type: 'box',
  code: '1-1',
  layer: 'sub',
  geometry: { type: 'Point', coordinates: [E + 50, N + 3] },
  lengthM: null,
};
const all = new Set<FeatureType>(['route', 'box', 'hhi', 'joint', 'mh']);

describe('viewport', () => {
  const vp: Viewport = {
    centerX: E + 50,
    centerY: N,
    metresPerPixel: 0.5,
    widthPx: 400,
    heightPx: 800,
  };

  it('fits the features with padding', () => {
    const bounds = boundsOf([route, box]);
    expect(bounds).toEqual({ minX: E, minY: N, maxX: E + 100, maxY: N + 3 });
    const fitted = fitBounds(bounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 }, 400, 800, 0);
    expect(fitted.centerX).toBe(E + 50);
    expect(fitted.metresPerPixel).toBe(0.25);
    expect(boundsOf([])).toBeNull();
  });

  it('maps world ↔ screen with y up in the CRS and down on screen', () => {
    expect(toScreen(vp, E + 50, N)).toEqual({ sx: 200, sy: 400 });
    expect(toScreen(vp, E + 60, N + 10)).toEqual({ sx: 220, sy: 380 });
    expect(toWorld(vp, 220, 380)).toEqual({ x: E + 60, y: N + 10 });
  });

  it('pans with the finger and zooms around the pinch focus', () => {
    const moved = pan(vp, 20, 20);
    expect(moved.centerX).toBe(E + 40);
    expect(moved.centerY).toBe(N + 10);
    const focus = toWorld(vp, 100, 100);
    const zoomed = zoomAt(vp, 2, 100, 100);
    expect(zoomed.metresPerPixel).toBe(0.25);
    const after = toWorld(zoomed, 100, 100);
    expect(after.x).toBeCloseTo(focus.x, 6);
    expect(after.y).toBeCloseTo(focus.y, 6);
    expect(zoomAt(vp, 1e12, 0, 0).metresPerPixel).toBe(0.001);
    expect(zoomAt(vp, 0, 0, 0)).toBe(vp);
  });

  it('picks the box under the crosshair before the route under it, and nothing when far', () => {
    expect(pickAtCrosshair([route, box], vp, all)?.id).toBe(box.id);
    expect(pickAtCrosshair([route, box], vp, new Set<FeatureType>(['route']))?.id).toBe(route.id);
    expect(pickAtCrosshair([route, box], { ...vp, centerY: N + 500 }, all)).toBeNull();
  });

  it('culls features outside the screen and hidden layers', () => {
    const farBox = {
      ...box,
      id: '00000000-0000-4000-8000-000000000003',
      geometry: { type: 'Point' as const, coordinates: [E + 5000, N] as [number, number] },
    };
    expect(visibleFeatures([route, box, farBox], vp, all).map((f) => f.id)).toEqual([
      route.id,
      box.id,
    ]);
    expect(visibleFeatures([route, box], vp, new Set<FeatureType>(['box']))).toEqual([box]);
  });

  it('formats E/N to the centimetre', () => {
    expect(formatEastingNorthing({ ...vp, centerX: 330050.123, centerY: 3340000.5 })).toEqual({
      e: '330050.12',
      n: '3340000.50',
    });
  });
});
