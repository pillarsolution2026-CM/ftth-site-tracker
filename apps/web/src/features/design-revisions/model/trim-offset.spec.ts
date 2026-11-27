import { describe, expect, it } from 'vitest';
import { arcOffset, fencePicks, throughArcDistance } from './trim-offset';

const arc = { x: 0, y: 0, r: 10, start: 0, end: 90 };

describe('OFFSET of arcs and circles (AutoCAD: a concentric arc / circle)', () => {
  it('goes out or in by the side clicked, keeping the angles', () => {
    expect(arcOffset(arc, 2, [20, 5])).toEqual({ x: 0, y: 0, r: 12, start: 0, end: 90 });
    expect(arcOffset(arc, 2, [3, 3])).toEqual({ x: 0, y: 0, r: 8, start: 0, end: 90 });
  });

  it('refuses an offset inward past the centre', () => {
    expect(arcOffset(arc, 10, [1, 1])).toBeNull();
    expect(arcOffset(arc, 12, [1, 1])).toBeNull();
  });

  it('Through: the distance from the arc to the point', () => {
    expect(throughArcDistance(arc, [0, 15])).toBeCloseTo(5);
    expect(throughArcDistance(arc, [0, 4])).toBeCloseTo(6);
  });
});

describe('TRIM fence (a drag in quick mode)', () => {
  it('gives the points where the fence crosses the object', () => {
    const line: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    expect(fencePicks(line, false, [5, -5], [5, 5])).toEqual([[5, 0]]);
    expect(fencePicks(line, false, [5, 1], [5, 5])).toEqual([]);
  });

  it('crosses a closed outline twice', () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(fencePicks(square, true, [-5, 5], [15, 5])).toEqual([
      [10, 5],
      [0, 5],
    ]);
  });
});
