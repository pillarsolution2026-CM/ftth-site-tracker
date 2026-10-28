import { describe, expect, it } from 'vitest';
import { createProjectCrs, GeometryError, utmProj4Definition, utmZoneFromEpsg } from './index.js';

// Reference values from pyproj 3.8 (PROJ), the library the CAD worker uses.
const PYPROJ_32636 = [
  { lon: 31.2357, lat: 30.0444, x: 329899.643042503, y: 3325016.736225272 },
  { lon: 31.2, lat: 30.18, x: 326694.1206189651, y: 3340099.9089017115 },
  { lon: 33, lat: 0, x: 500000, y: 0 },
];

describe('utmZoneFromEpsg', () => {
  it('reads zone and hemisphere', () => {
    expect(utmZoneFromEpsg(32636)).toEqual({ zone: 36, hemisphere: 'north' });
    expect(utmZoneFromEpsg(32601)).toEqual({ zone: 1, hemisphere: 'north' });
    expect(utmZoneFromEpsg(32760)).toEqual({ zone: 60, hemisphere: 'south' });
  });

  it.each([4326, 32600, 32661, 32700, 32761, 22992, 32636.5])('rejects EPSG:%s', (epsg) => {
    expect(() => utmZoneFromEpsg(epsg)).toThrow(GeometryError);
  });

  it('builds the proj4 definition', () => {
    expect(utmProj4Definition({ zone: 36, hemisphere: 'north' })).toBe(
      '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs',
    );
    expect(utmProj4Definition({ zone: 36, hemisphere: 'south' })).toContain('+south');
  });
});

describe('createProjectCrs', () => {
  const crs = createProjectCrs(32636);

  it.each(PYPROJ_32636)(
    'matches pyproj at ($lon, $lat) to the millimetre',
    ({ lon, lat, x, y }) => {
      const p = crs.fromWgs84({ lon, lat });
      expect(Math.abs(p.x - x)).toBeLessThan(0.001);
      expect(Math.abs(p.y - y)).toBeLessThan(0.001);
      const back = crs.toWgs84({ x, y });
      expect(back.lon).toBeCloseTo(lon, 8);
      expect(back.lat).toBeCloseTo(lat, 8);
    },
  );

  it('handles the southern hemisphere', () => {
    const p = createProjectCrs(32736).fromWgs84({ lon: 35, lat: -6 });
    expect(Math.abs(p.x - 721383.1455096453)).toBeLessThan(0.001);
    expect(Math.abs(p.y - 9336391.424671426)).toBeLessThan(0.001);
  });

  it('rejects impossible WGS84 input instead of returning a wrong point', () => {
    for (const bad of [
      { lon: 33, lat: 1e10 },
      { lon: 213, lat: 0 },
      { lon: 33, lat: -90.5 },
    ]) {
      expect(() => crs.fromWgs84(bad)).toThrow(
        expect.objectContaining({ code: 'COORDINATE_OUT_OF_RANGE' }),
      );
    }
    expect(crs.fromWgs84({ lon: -180, lat: 90 })).toBeDefined();
  });

  it('rejects a transform that overflows', () => {
    expect(() => crs.toWgs84({ x: 1e30, y: 1e30 })).toThrow(
      expect.objectContaining({ code: 'NON_FINITE_COORDINATE' }),
    );
  });

  it('rejects non-finite input', () => {
    expect(() => crs.toWgs84({ x: Number.NaN, y: 0 })).toThrow(GeometryError);
    expect(() => crs.fromWgs84({ lon: 31, lat: Infinity })).toThrow(GeometryError);
  });
});
