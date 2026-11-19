import { describe, expect, it } from 'vitest';
import {
  arcThrough,
  circlePoints,
  circleThrough,
  CIRCLE_SEGMENTS,
  crossings,
  curveLength,
  distance,
  fillet,
  GeometryError,
  nearestOnCurve,
  offsetCurve,
  rectanglePoints,
  slice,
  stretchCurve,
  trimCurve,
  type Pt,
} from './geometry';

const close = (actual: readonly Pt[], expected: readonly Pt[]) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((p, i) => {
    expect(p[0]).toBeCloseTo((expected[i] as Pt)[0], 6);
    expect(p[1]).toBeCloseTo((expected[i] as Pt)[1], 6);
  });
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GeometryError ? error.code : 'OTHER';
  }
  return null;
};

describe('shapes (ADR-051)', () => {
  it('a circle is a closed polyline of points at the radius', () => {
    const pts = circlePoints([10, 5], 2);
    expect(pts).toHaveLength(CIRCLE_SEGMENTS);
    for (const p of pts) expect(distance(p, [10, 5])).toBeCloseTo(2, 9);
    close([pts[0] as Pt], [[12, 5]]);
    expect(code(() => circlePoints([0, 0], 0))).toBe('RADIUS');
  });

  it('a circle through three points; none when they are on one line', () => {
    const c = circleThrough([1, 0], [0, 1], [-1, 0]);
    expect(c?.radius).toBeCloseTo(1, 9);
    close([c?.center as Pt], [[0, 0]]);
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
  });

  it('an arc goes from the start through the second point to the end', () => {
    const ccw = arcThrough([1, 0], [0, 1], [-1, 0]);
    expect(ccw[0]).toEqual([1, 0]);
    expect(ccw[ccw.length - 1]).toEqual([-1, 0]);
    expect(ccw.every((p) => p[1] >= -1e-9)).toBe(true); // the upper half
    const cw = arcThrough([1, 0], [0, -1], [-1, 0]);
    expect(cw.every((p) => p[1] <= 1e-9)).toBe(true); // the lower half
    for (const p of cw) expect(distance(p, [0, 0])).toBeCloseTo(1, 9);
    expect(code(() => arcThrough([0, 0], [1, 0], [2, 0]))).toBe('COLLINEAR');
  });

  it('a rectangle from two corners', () => {
    expect(rectanglePoints([0, 0], [4, 2])).toEqual([
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ]);
    expect(code(() => rectanglePoints([0, 0], [4, 0]))).toBe('FLAT');
  });
});

describe('measures', () => {
  const l: Pt[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  it('length, nearest place and slices along a curve', () => {
    expect(curveLength(l, false)).toBe(20);
    expect(curveLength(l, true)).toBeCloseTo(20 + Math.SQRT2 * 10, 9);
    const near = nearestOnCurve(l, false, [12, 4]);
    expect(near).toMatchObject({ segment: 1, along: 14, distance: 2 });
    close(slice(l, false, 5, 15), [
      [5, 0],
      [10, 0],
      [10, 5],
    ]);
  });
  it('crossings with edges, sorted', () => {
    const edges = [
      {
        points: [
          [3, -1],
          [3, 1],
        ] as Pt[],
        closed: false,
      },
      {
        points: [
          [8, 5],
          [12, 5],
        ] as Pt[],
        closed: false,
      },
    ];
    expect(crossings(l, false, edges)).toEqual([3, 15]);
  });
});

describe('TRIM', () => {
  const line: Pt[] = [
    [0, 0],
    [10, 0],
  ];
  const edge = (x: number) => ({
    points: [
      [x, -1],
      [x, 1],
    ] as Pt[],
    closed: false,
  });
  it('removes the clicked end piece beyond one edge', () => {
    close(trimCurve(line, false, [edge(4)], [8, 0.1])[0] as Pt[], [
      [0, 0],
      [4, 0],
    ]);
    close(trimCurve(line, false, [edge(4)], [1, 0])[0] as Pt[], [
      [4, 0],
      [10, 0],
    ]);
  });
  it('removes the middle between two edges and leaves two pieces', () => {
    const pieces = trimCurve(line, false, [edge(3), edge(7)], [5, 0]);
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
  it('is refused when no edge crosses; a closed curve needs two crossings', () => {
    expect(code(() => trimCurve(line, false, [edge(20)], [5, 0]))).toBe('NO_CROSSING');
    const square = rectanglePoints([0, 0], [10, 10]);
    expect(code(() => trimCurve(square, true, [edge(5)], [5, 0]))).toBe('NO_CROSSING');
  });
  it('opens a closed curve between two crossings', () => {
    const square = rectanglePoints([0, 0], [10, 10]);
    const cut = {
      points: [
        [5, -1],
        [5, 11],
      ] as Pt[],
      closed: false,
    };
    // Click the bottom-right side: the right half goes, the left half stays.
    const [kept] = trimCurve(square, true, [cut], [10, 5]);
    expect(kept?.every((p) => p[0] <= 5 + 1e-9)).toBe(true);
    close(
      [kept?.[0] as Pt, kept?.[kept.length - 1] as Pt],
      [
        [5, 10],
        [5, 0],
      ],
    );
    // Click the left side (across the closing point at (0, 0)): the left half goes.
    const [right] = trimCurve(square, true, [cut], [0, 5]);
    expect(right?.every((p) => p[0] >= 5 - 1e-9)).toBe(true);
  });
});

describe('OFFSET', () => {
  it('a line moves to the picked side by the distance', () => {
    const line: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    close(offsetCurve(line, false, 2, [5, 3]), [
      [0, 2],
      [10, 2],
    ]);
    close(offsetCurve(line, false, 2, [5, -3]), [
      [0, -2],
      [10, -2],
    ]);
    expect(code(() => offsetCurve(line, false, 0, [5, 3]))).toBe('DISTANCE');
  });
  it('a polyline keeps sharp corners; a closed one grows or shrinks', () => {
    const l: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    close(offsetCurve(l, false, 1, [5, 1]), [
      [0, 1],
      [9, 1],
      [9, 10],
    ]);
    const square = rectanglePoints([0, 0], [10, 10]);
    close(offsetCurve(square, true, 1, [5, -1]), [
      [-1, -1],
      [11, -1],
      [11, 11],
      [-1, 11],
    ]);
  });
});

describe('FILLET', () => {
  const horizontal = {
    points: [
      [0, 0],
      [8, 0],
    ] as Pt[],
    closed: false,
    pick: [2, 0] as Pt,
  };
  const vertical = {
    points: [
      [10, 2],
      [10, 10],
    ] as Pt[],
    closed: false,
    pick: [10, 8] as Pt,
  };
  it('radius 0 extends both lines to their corner', () => {
    const [a, b] = fillet(horizontal, vertical, 0);
    close(a, [
      [0, 0],
      [10, 0],
    ]);
    close(b, [
      [10, 0],
      [10, 10],
    ]);
  });
  it('radius 0 trims crossing lines on the picked sides', () => {
    const across = {
      points: [
        [5, -5],
        [5, 5],
      ] as Pt[],
      closed: false,
      pick: [5, 4] as Pt,
    };
    const [a, b] = fillet(horizontal, across, 0);
    close(a, [
      [0, 0],
      [5, 0],
    ]);
    close(b, [
      [5, 0],
      [5, 5],
    ]);
  });
  it('a radius puts an arc between the two lines, tangent to both', () => {
    const [a, b] = fillet(horizontal, vertical, 2);
    expect(a[0]).toEqual([0, 0]);
    close([a[1] as Pt], [[8, 0]]); // the tangent point on the horizontal line
    close(
      [a[a.length - 1] as Pt, b[0] as Pt],
      [
        [10, 2],
        [10, 2],
      ],
    );
    for (const p of a.slice(1)) expect(distance(p, [8, 2])).toBeCloseTo(2, 6);
    close([b[b.length - 1] as Pt], [[10, 10]]);
  });
  it('refuses parallel lines, closed curves and a radius too large', () => {
    const parallel = {
      points: [
        [0, 1],
        [8, 1],
      ] as Pt[],
      closed: false,
      pick: [2, 1] as Pt,
    };
    expect(code(() => fillet(horizontal, parallel, 0))).toBe('PARALLEL');
    expect(code(() => fillet({ ...horizontal, closed: true }, vertical, 0))).toBe('CLOSED');
    expect(code(() => fillet(horizontal, vertical, 50))).toBe('RADIUS_TOO_LARGE');
  });
});

describe('STRETCH', () => {
  it('moves only the vertices inside the window', () => {
    const l: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(stretchCurve(l, { minX: 9, minY: -1, maxX: 11, maxY: 1 }, 5, 0)).toEqual([
      [0, 0],
      [15, 0],
      [10, 10],
    ]);
    expect(stretchCurve(l, { minX: 50, minY: 50, maxX: 60, maxY: 60 }, 5, 0)).toBeNull();
  });
});
