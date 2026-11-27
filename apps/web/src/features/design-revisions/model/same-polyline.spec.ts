import { describe, expect, it } from 'vitest';
import { chamfer, fillet, type Pt } from './geometry';
import { cornerOnOne } from './same-polyline';

const L: Pt[] = [
  [0, 0],
  [10, 0],
  [10, 10],
];
const sharp = (r: number) => (a: Parameters<typeof fillet>[0], b: Parameters<typeof fillet>[1]) =>
  fillet(a, b, r);

describe('FILLET / CHAMFER on two segments of the same polyline (AutoCAD)', () => {
  it('rounds the corner between two adjacent segments, the polyline stays one', () => {
    const out = cornerOnOne(L, false, [5, 0], [10, 5], sharp(2));
    expect(out?.closed).toBe(false);
    const pts = out?.points ?? [];
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[1]?.[0]).toBeCloseTo(8);
    expect(pts[pts.length - 2]?.[1]).toBeCloseTo(2);
    expect(pts[pts.length - 1]).toEqual([10, 10]);
  });

  it('either order of picks; radius 0 keeps the sharp corner', () => {
    expect(cornerOnOne(L, false, [10, 5], [5, 0], sharp(0))?.points).toEqual(L);
  });

  it('refuses segments that are not adjacent', () => {
    const z: Pt[] = [...L, [20, 10]];
    expect(cornerOnOne(z, false, [5, 0], [15, 10], sharp(1))).toBeNull();
    expect(cornerOnOne(z, false, [5, 0], [6, 0], sharp(1))).toBeNull();
  });

  it('works on the closing corner of a closed polyline and keeps it closed', () => {
    const square: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const out = cornerOnOne(square, true, [0, 5], [5, 0], (a, b) => chamfer(a, b, 2, 2));
    expect(out?.closed).toBe(true);
    expect(out?.points).toHaveLength(5);
    expect(out?.points).toContainEqual([0, 2]);
    expect(out?.points).toContainEqual([2, 0]);
    expect(out?.points).not.toContainEqual([0, 0]);
    expect(out?.added).toEqual([
      [0, 2],
      [2, 0],
    ]);
  });
});
