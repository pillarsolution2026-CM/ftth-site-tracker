import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAFTING,
  formatCoordinates,
  formatLength,
  formatPolar,
  gridPoint,
  orthoPoint,
  parseDrafting,
  polarAngles,
  polarPoint,
  resolvePoint,
  toggleOrtho,
  togglePolar,
  trackingPoint,
} from './drafting';

describe('drafting aids', () => {
  it('starts with AutoCAD defaults and reads broken storage back as defaults', () => {
    expect(DEFAULT_DRAFTING).toMatchObject({
      osnap: true,
      polar: true,
      otrack: true,
      dyn: true,
      ortho: false,
    });
    expect(parseDrafting(null)).toEqual(DEFAULT_DRAFTING);
    expect(parseDrafting({ snapX: -1, units: 'x', precision: 99 })).toMatchObject({
      snapX: 10,
      units: 'decimal',
      precision: 4,
    });
  });

  it('Ortho and Polar turn each other off (F8 / F10)', () => {
    const ortho = toggleOrtho(DEFAULT_DRAFTING);
    expect(ortho).toMatchObject({ ortho: true, polar: false });
    expect(togglePolar(ortho)).toMatchObject({ ortho: false, polar: true });
  });

  it('Ortho keeps the larger of dx / dy', () => {
    expect(orthoPoint([0, 0], [10, 3])).toEqual([10, 0]);
    expect(orthoPoint([0, 0], [2, -9])).toEqual([0, -9]);
  });

  it('Polar tracking slides onto the nearest tracking path; PolarSnap rounds the distance', () => {
    expect(polarAngles(90)).toEqual([0, 90, 180, 270]);
    expect(polarAngles(90, [30])).toContain(30);
    const p = polarPoint([0, 0], [10, 0.5], [0, 90], 1);
    expect(p).toMatchObject({ angle: 0 });
    expect(p?.at[1]).toBeCloseTo(0);
    expect(polarPoint([0, 0], [10, 3], [0, 90], 1)).toBeNull();
    expect(polarPoint([0, 0], [13, 0.2], [0], 1, 5)?.distance).toBe(15);
  });

  it('Snap rounds to the grid', () => {
    expect(gridPoint([13, 26], 10, 10)).toEqual([10, 30]);
  });

  it('object snap tracking: one path, or the crossing of two', () => {
    const one = trackingPoint([{ at: [0, 0], dir: null }], [10, 0.4], [0, 90, 180, 270], 1);
    expect(one?.at[1]).toBeCloseTo(0);
    const two = trackingPoint(
      [
        { at: [0, 0], dir: null },
        { at: [10, 10], dir: null },
      ],
      [10.3, 0.3],
      [0, 90, 180, 270],
      1,
    );
    expect(two?.paths).toHaveLength(2);
    expect(two?.at[0]).toBeCloseTo(10);
    expect(two?.at[1]).toBeCloseTo(0);
  });

  it('resolves in AutoCAD order: object snap, then tracking, then Ortho / Polar', () => {
    const s = { ...DEFAULT_DRAFTING, otrack: false };
    const snap = { mode: 'endpoint' as const, at: [5, 5] as const };
    expect(
      resolvePoint({ cursor: [5.2, 5], anchor: [0, 0], settings: s, snaps: [snap], aperture: 1 })
        .at,
    ).toEqual([5, 5]);
    const polar = resolvePoint({
      cursor: [10, 0.3],
      anchor: [0, 0],
      settings: s,
      snaps: [],
      aperture: 1,
    });
    expect(polar.polar?.angle).toBe(0);
    const ortho = resolvePoint({
      cursor: [10, 3],
      anchor: [0, 0],
      settings: toggleOrtho(s),
      snaps: [],
      aperture: 1,
    });
    expect(ortho.at).toEqual([10, 0]);
    const free = resolvePoint({
      cursor: [10, 3],
      anchor: null,
      settings: s,
      snaps: [],
      aperture: 1,
    });
    expect(free.at).toEqual([10, 3]);
  });

  it('formats lengths as AutoCAD units', () => {
    expect(formatLength(12.5, 'decimal', 4)).toBe('12.5000');
    expect(formatLength(1234.5, 'scientific', 4)).toBe('1.2345E+03');
    expect(formatLength(123.5, 'engineering', 2)).toBe(`10'-3.50"`);
    expect(formatLength(123.5, 'architectural', 4)).toBe(`10'-3 1/2"`);
    expect(formatLength(2.25, 'fractional', 4)).toBe('2 1/4');
    expect(formatCoordinates([1, 2], 'decimal', 2)).toBe('1.00, 2.00, 0.00');
    expect(formatPolar(10, 450, 'decimal', 1)).toBe('10.0 < 90°');
  });
});
