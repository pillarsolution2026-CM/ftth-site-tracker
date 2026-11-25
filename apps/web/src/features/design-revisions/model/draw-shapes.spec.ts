import { describe, expect, it } from 'vitest';
import {
  arrayOffsets,
  asLoop,
  breakCurve,
  chainLoop,
  cvSpline,
  divideCurve,
  ellipsePoints,
  fitSpline,
  helixPoints,
  insidePolygon,
  lengthenEnd,
  loopAround,
  measureCurve,
  polygonArea,
  polygonOnEdge,
  polygonPoints,
  splitAt,
} from './draw-shapes';
import { curveLength, GeometryError, type Pt } from './geometry';

const close = (a: readonly Pt[], b: readonly Pt[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => {
    expect(p[0]).toBeCloseTo((b[i] as Pt)[0], 6);
    expect(p[1]).toBeCloseTo((b[i] as Pt)[1], 6);
  });
};
const line: Pt[] = [
  [0, 0],
  [10, 0],
];
const square: Pt[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('BREAK and BREAKATPOINT', () => {
  it('an open line loses the part between the two points', () => {
    const pieces = breakCurve(line, false, 7, 3);
    expect(pieces).toHaveLength(2);
    close(pieces[0] as Pt[], [
      [0, 0],
      [3, 0],
    ]);
    close(pieces[1] as Pt[], [
      [7, 0],
      [10, 0],
    ]);
  });
  it('breaking at the end leaves one piece', () => {
    expect(breakCurve(line, false, 5, 10)).toHaveLength(1);
  });
  it('a closed square leaves one open piece going round from the second point', () => {
    const [piece] = breakCurve(square, true, 5, 15);
    expect(curveLength(piece as Pt[], false)).toBeCloseTo(30, 6);
    expect(piece?.[0]).toEqual([10, 5]);
    expect(piece?.[piece.length - 1]).toEqual([5, 0]);
  });
  it('at one point an open line is split in two; a closed one cannot', () => {
    const [a, b] = splitAt(line, false, 4);
    close(a, [
      [0, 0],
      [4, 0],
    ]);
    close(b, [
      [4, 0],
      [10, 0],
    ]);
    expect(() => splitAt(square, true, 4)).toThrow(GeometryError);
    expect(() => splitAt(line, false, 0)).toThrow(GeometryError);
  });
});

describe('LENGTHEN', () => {
  it('lengthens the end straight on, or cuts it back', () => {
    close(lengthenEnd(line, false, 5), [
      [0, 0],
      [15, 0],
    ]);
    close(lengthenEnd(line, true, 2), [
      [-2, 0],
      [10, 0],
    ]);
    close(lengthenEnd(line, false, -4), [
      [0, 0],
      [6, 0],
    ]);
    expect(() => lengthenEnd(line, false, -10)).toThrow(GeometryError);
  });
});

describe('ARRAYRECT', () => {
  it('gives every copy but the source', () => {
    expect(arrayOffsets(3, 2, 5, 7)).toEqual([
      [5, 0],
      [10, 0],
      [0, 7],
      [5, 7],
      [10, 7],
    ]);
  });
});

describe('ELLIPSE, POLYGON, HELIX', () => {
  it('an ellipse has its axes; an elliptical arc runs between the angles', () => {
    const points = ellipsePoints([0, 0], [10, 0], 0.5);
    expect(Math.max(...points.map((p) => p[0]))).toBeCloseTo(10, 6);
    expect(Math.max(...points.map((p) => p[1]))).toBeCloseTo(5, 1);
    const arc = ellipsePoints([0, 0], [10, 0], 0.5, 0, 90);
    close(
      [arc[0] as Pt, arc[arc.length - 1] as Pt],
      [
        [10, 0],
        [0, 5],
      ],
    );
    expect(() => ellipsePoints([0, 0], [0, 0], 0.5)).toThrow(GeometryError);
  });
  it('a polygon inscribed or circumscribed about a circle, or on an edge', () => {
    const inscribed = polygonPoints([0, 0], 4, 10, true, 0);
    expect(inscribed[0]?.[0]).toBeCloseTo(10, 6);
    expect(polygonArea(inscribed)).toBeCloseTo(200, 6);
    expect(polygonArea(polygonPoints([0, 0], 4, 10, false))).toBeCloseTo(400, 6);
    const onEdge = polygonOnEdge([0, 0], [10, 0], 4);
    close(onEdge, square);
    expect(() => polygonPoints([0, 0], 2, 10, true)).toThrow(GeometryError);
  });
  it('a helix seen from above spirals from the base to the top radius', () => {
    const points = helixPoints([0, 0], 10, 5, 2);
    close([points[0] as Pt], [[10, 0]]);
    close([points[points.length - 1] as Pt], [[5, 0]]);
  });
});

describe('SPLINE', () => {
  it('Fit goes through every point', () => {
    const through: Pt[] = [
      [0, 0],
      [10, 5],
      [20, 0],
      [30, 5],
    ];
    const curve = fitSpline(through);
    for (const p of through) {
      expect(curve.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9)).toBe(true);
    }
  });
  it('CV starts and ends on the end vertices and stays in their hull', () => {
    const cv: Pt[] = [
      [0, 0],
      [10, 10],
      [20, -10],
      [30, 0],
    ];
    const curve = cvSpline(cv);
    close(
      [curve[0] as Pt, curve[curve.length - 1] as Pt],
      [
        [0, 0],
        [30, 0],
      ],
    );
    expect(Math.max(...curve.map((p) => Math.abs(p[1])))).toBeLessThan(10);
  });
});

describe('DIVIDE and MEASURE', () => {
  it('divide marks equal parts; measure marks every length', () => {
    close(divideCurve(line, false, 4), [
      [2.5, 0],
      [5, 0],
      [7.5, 0],
    ]);
    expect(divideCurve(square, true, 4)).toHaveLength(4);
    close(measureCurve(line, false, 3), [
      [3, 0],
      [6, 0],
      [9, 0],
    ]);
    expect(() => divideCurve(line, false, 1)).toThrow(GeometryError);
  });
});

describe('closed boundaries', () => {
  it('finds the smallest loop around a point', () => {
    const big = square.map(([x, y]) => [x * 3 - 10, y * 3 - 10] as Pt);
    expect(insidePolygon(square, [5, 5])).toBe(true);
    expect(loopAround([big, square], [5, 5])).toEqual(square);
    expect(loopAround([big, square], [15, 15])).toEqual(big);
    expect(loopAround([square], [50, 50])).toBeNull();
  });
  it('a curve back on its first point is a loop', () => {
    expect(asLoop([...square, [0, 0]], false)).toEqual(square);
    expect(asLoop(square, false)).toBeNull();
    expect(asLoop(square, true)).toEqual(square);
  });
  it('chains pieces end to end into one loop, in any direction', () => {
    const loop = chainLoop(
      [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [10, 10],
          [10, 0],
        ],
        [
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
      1e-6,
    );
    expect(loop && polygonArea(loop)).toBeCloseTo(100, 6);
    expect(
      chainLoop(
        [
          [
            [0, 0],
            [10, 0],
          ],
          [
            [10, 0],
            [10, 10],
          ],
        ],
        1e-6,
      ),
    ).toBeNull();
  });
});
