import { describe, expect, it } from 'vitest';
import {
  arcSegmentCount,
  bulgePoints,
  bulgePolylineLength,
  bulgeSegmentLength,
  distance,
  FLATTEN_TOLERANCE_M,
  flattenBulgePolyline,
  GeometryError,
  MAX_ARC_SEGMENTS,
  polylineLength,
} from './index.js';

const a = { x: 0, y: 0 };
const b = { x: 10, y: 0 };

describe('arcSegmentCount', () => {
  it('matches the worker formula', () => {
    // r = 5, half circle, 1 mm: step = 2·acos(1 − 0.001/5) ≈ 0.04 rad → 79 chords.
    expect(arcSegmentCount(5, Math.PI)).toBe(
      Math.ceil(Math.PI / (2 * Math.acos(1 - FLATTEN_TOLERANCE_M / 5))),
    );
    expect(arcSegmentCount(0, Math.PI)).toBe(1);
    expect(arcSegmentCount(5, 0)).toBe(1);
    expect(arcSegmentCount(0.0001, Math.PI)).toBe(1);
    expect(arcSegmentCount(1e12, 1)).toBe(MAX_ARC_SEGMENTS);
    // tolerance / radius below float precision: the step rounds to 0.
    expect(arcSegmentCount(1e30, 1)).toBe(MAX_ARC_SEGMENTS);
  });

  it('rejects a non-positive tolerance', () => {
    expect(() => arcSegmentCount(5, 1, 0)).toThrow(GeometryError);
  });
});

describe('bulgePoints', () => {
  it('turns bulge 1 into a counter-clockwise half circle below the chord', () => {
    const points = bulgePoints(a, b, 1);
    expect(points[0]).toBe(a);
    expect(points[points.length - 1]).toBe(b);
    for (const p of points) expect(distance(p, { x: 5, y: 0 })).toBeCloseTo(5, 9);
    // CCW from (0,0) to (10,0) around (5,0) passes through (5,−5); chords cut inside by ≤ 1 mm.
    const lowest = Math.min(...points.map((p) => p.y));
    expect(lowest).toBeGreaterThanOrEqual(-5 - 1e-9);
    expect(lowest).toBeLessThan(-5 + FLATTEN_TOLERANCE_M);
  });

  it('bulges the other way for a negative bulge', () => {
    const highest = Math.max(...bulgePoints(a, b, -1).map((p) => p.y));
    expect(highest).toBeLessThanOrEqual(5 + 1e-9);
    expect(highest).toBeGreaterThan(5 - FLATTEN_TOLERANCE_M);
  });

  it('keeps straight segments and zero chords as two points', () => {
    expect(bulgePoints(a, b, 0)).toEqual([a, b]);
    expect(bulgePoints(a, a, 0.5)).toEqual([a, a]);
  });

  it('rejects a non-finite bulge', () => {
    expect(() => bulgePoints(a, b, Number.NaN)).toThrow(GeometryError);
  });
});

describe('lengths', () => {
  it('gives the exact arc length', () => {
    expect(bulgeSegmentLength(a, b, 1)).toBeCloseTo(5 * Math.PI, 12);
    expect(bulgeSegmentLength(a, b, 0)).toBe(10);
    // Quarter circle: bulge = tan(π/8), chord 10 → r = 10/√2.
    expect(bulgeSegmentLength(a, b, Math.tan(Math.PI / 8))).toBeCloseTo(
      (10 / Math.SQRT2) * (Math.PI / 2),
      12,
    );
  });

  // Each chord with sagitta s ≤ tol is short by ≈ r·δ³/24 with δ² ≈ 8·tol/r, so in total
  // the flattened length is short by at most ≈ |sweep| · tol / 3 (about 1 mm on a half circle).
  it('flattened length is short of the true length by at most sweep × tolerance / 3', () => {
    const { points, approximated } = flattenBulgePolyline([
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0 },
    ]);
    expect(approximated).toBe(true);
    const flattened = polylineLength(points);
    expect(flattened).toBeLessThanOrEqual(5 * Math.PI);
    expect(5 * Math.PI - flattened).toBeLessThanOrEqual((Math.PI * FLATTEN_TOLERANCE_M) / 3);
  });
});

describe('flattenBulgePolyline', () => {
  it('flattens a closed polyline including its closing bulge', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10, bulge: 1 },
    ];
    const open = flattenBulgePolyline(square);
    expect(open.approximated).toBe(false);
    expect(open.points).toHaveLength(4);

    const closed = flattenBulgePolyline(square, { closed: true });
    expect(closed.approximated).toBe(true);
    expect(closed.points[closed.points.length - 1]).toEqual({ x: 0, y: 0 });
    expect(bulgePolylineLength(square, true)).toBeCloseTo(30 + 5 * Math.PI, 9);
    expect(bulgePolylineLength(square)).toBe(30);
  });

  it('strips bulge from the output and honours a coarser tolerance', () => {
    const fine = flattenBulgePolyline([{ x: 0, y: 0, bulge: 1 }, b]);
    const coarse = flattenBulgePolyline([{ x: 0, y: 0, bulge: 1 }, b], { tolerance: 0.5 });
    expect(coarse.points.length).toBeLessThan(fine.points.length);
    expect(Object.keys(fine.points[0] as object)).toEqual(['x', 'y']);
  });

  it('needs two vertices', () => {
    expect(() => flattenBulgePolyline([a])).toThrow(GeometryError);
    expect(() => bulgePolylineLength([a])).toThrow(GeometryError);
  });
});
