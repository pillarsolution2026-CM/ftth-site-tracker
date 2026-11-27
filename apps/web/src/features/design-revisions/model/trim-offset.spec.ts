import { describe, expect, it } from 'vitest';
import { arcOffset, extendArc, fencePicks, throughArcDistance, trimAtPicks } from './trim-offset';

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

describe('TRIM fence crossing one object twice', () => {
  it('removes both pieces the fence crosses', () => {
    const line: [number, number][] = [
      [0, 0],
      [30, 0],
    ];
    const edges = [
      {
        points: [
          [10, -5],
          [10, 5],
        ] as [number, number][],
        closed: false,
      },
      {
        points: [
          [20, -5],
          [20, 5],
        ] as [number, number][],
        closed: false,
      },
    ];
    expect(
      trimAtPicks(line, false, edges, [
        [5, 0],
        [25, 0],
      ]).pieces,
    ).toEqual([
      [
        [10, 0],
        [20, 0],
      ],
    ]);
  });
});

describe('EXTEND of an arc', () => {
  const quarter = { x: 0, y: 0, r: 10, start: 0, end: 90 };
  const wall = (x0: number, y0: number, x1: number, y1: number) => ({
    points: [
      [x0, y0],
      [x1, y1],
    ] as [number, number][],
    closed: false,
  });

  it('runs the picked end on along its circle to the edge', () => {
    // The end at 0,10 runs on to the vertical line x = -10 → angle 180.
    const out = extendArc(quarter, [wall(-10, -20, -10, 20)], [1, 9]);
    expect(out.start).toBeCloseTo(0);
    expect(out.end).toBeCloseTo(180);
  });

  it('runs the start back to the edge', () => {
    // The start at 10,0 runs back (clockwise) to the line y = -10 → angle 270.
    const out = extendArc(quarter, [wall(-20, -10, 20, -10)], [9, 1]);
    expect(out.start).toBeCloseTo(270);
    expect(out.end).toBeCloseTo(450);
  });

  it('says so when no edge is met', () => {
    expect(() => extendArc(quarter, [wall(50, 0, 60, 0)], [1, 9])).toThrow();
  });
});
