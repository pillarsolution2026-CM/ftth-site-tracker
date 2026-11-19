import { describe, expect, it } from 'vitest';
import { distance, GeometryError, type Pt } from './geometry';
import {
  arcCenter,
  arcEndDirection,
  arcThroughEndDirection,
  arcStartEnd,
  chamferPolygon,
  circleTangentTangent,
  endDirection,
  extendCurve,
  filletPolyline,
  rectangleFrom,
  rotatedRectangle,
  tangentArc,
  throughDistance,
} from './geometry-options';

const near = (a: Pt | undefined, b: Pt) => {
  expect(a?.[0]).toBeCloseTo(b[0], 6);
  expect(a?.[1]).toBeCloseTo(b[1], 6);
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GeometryError ? error.code : 'OTHER';
  }
  return null;
};

describe('PLINE Arc', () => {
  it('leaves the last point along the last direction and ends at the end point', () => {
    // Heading +X from (0, 0) to (10, 10): a quarter circle of radius 10 about (0, 10).
    const arc = tangentArc([0, 0], [1, 0], [10, 10]);
    near(arc[arc.length - 1], [10, 10]);
    for (const p of arc) expect(distance(p, [0, 10])).toBeCloseTo(10, 6);
    expect(arc[0]?.[1]).toBeGreaterThanOrEqual(0);
    // Turning right: the centre is below.
    const right = tangentArc([0, 0], [1, 0], [10, -10]);
    for (const p of right) expect(distance(p, [0, -10])).toBeCloseTo(10, 6);
    // Straight ahead: just the end point.
    expect(tangentArc([0, 0], [1, 0], [5, 0])).toEqual([[5, 0]]);
    expect(endDirection([[0, 0]])).toEqual([1, 0]);
    near(
      endDirection([
        [0, 0],
        [0, 4],
      ]),
      [0, 1],
    );
  });
});

describe('FILLET Polyline and RECTANG corners', () => {
  it('rounds every corner it can and counts those too short', () => {
    const l: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const done = filletPolyline(l, false, 2);
    expect(done.filleted).toBe(1);
    near(done.points[1], [8, 0]);
    near(done.points[done.points.length - 2], [10, 2]);
    const short = filletPolyline(l, false, 9);
    expect(short).toMatchObject({ filleted: 0, tooShort: 1 });
    const square: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(filletPolyline(square, true, 1).filleted).toBe(4);
    expect(code(() => filletPolyline(l, false, 0))).toBe('RADIUS');
  });
  it('chamfers each corner of a rectangle', () => {
    const square: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const cut = chamferPolygon(square, 1, 2);
    expect(cut).toHaveLength(8);
    near(cut[0], [0, 1]);
    near(cut[1], [2, 0]);
    expect(code(() => chamferPolygon(square, 6, 6))).toBe('RADIUS_TOO_LARGE');
  });
});

describe('RECTANG Dimensions, Rotation', () => {
  it('builds a rectangle of a length and width on the side of the other point', () => {
    expect(rectangleFrom([0, 0], 10, 5, 0, [-1, -1])).toEqual([
      [0, 0],
      [-10, 0],
      [-10, -5],
      [0, -5],
    ]);
    const turned = rectangleFrom([0, 0], 10, 5, 90, [-1, 1]);
    near(turned[1], [0, 10]);
    near(turned[3], [-5, 0]);
    expect(code(() => rectangleFrom([0, 0], 0, 5, 0, null))).toBe('FLAT');
  });
  it('a rotated rectangle keeps the two corners given', () => {
    const r = rotatedRectangle([0, 0], [0, 10], 45);
    near(r[2], [0, 10]);
    near(r[1], [5, 5]);
  });
});

describe('CIRCLE Ttr', () => {
  it('finds the centre at the radius from both lines, on the picked sides', () => {
    const c = circleTangentTangent(
      [
        [0, 0],
        [10, 0],
      ],
      [5, 0.5],
      [
        [0, 0],
        [0, 10],
      ],
      [0.5, 5],
      2,
    );
    near(c, [2, 2]);
    expect(
      code(() =>
        circleTangentTangent(
          [
            [0, 0],
            [1, 0],
          ],
          [0, 0],
          [
            [0, 1],
            [1, 1],
          ],
          [0, 1],
          1,
        ),
      ),
    ).toBe('PARALLEL');
  });
});

describe('ARC Center and Start-End', () => {
  it('goes counter-clockwise from the start about the centre, or by an included angle', () => {
    const half = arcCenter([0, 0], [5, 0], [-5, 0], null);
    near(half[half.length - 1], [-5, 0]);
    expect(half.every((p) => p[1] >= -1e-9)).toBe(true);
    const cw = arcCenter([0, 0], [5, 0], null, -90);
    near(cw[cw.length - 1], [0, -5]);
  });
  it('by radius (negative = major arc) and by included angle', () => {
    const minor = arcStartEnd([5, 0], [-5, 0], { radius: 5 });
    for (const p of minor) expect(distance(p, [0, 0])).toBeCloseTo(5, 6);
    expect(minor.every((p) => p[1] >= -1e-9)).toBe(true);
    const byAngle = arcStartEnd([5, 0], [0, 5], { angle: 90 });
    for (const p of byAngle) expect(distance(p, [0, 0])).toBeCloseTo(5, 6);
    expect(code(() => arcStartEnd([0, 0], [10, 0], { radius: 2 }))).toBe('RADIUS');
  });
});

describe('TRIM shift-select Extend and OFFSET Through', () => {
  it('extends the picked end to the nearest edge along it', () => {
    const edges = [
      {
        points: [
          [20, -5],
          [20, 5],
        ] as Pt[],
        closed: false,
      },
      {
        points: [
          [30, -5],
          [30, 5],
        ] as Pt[],
        closed: false,
      },
    ];
    const line: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(extendCurve(line, edges, [9, 0])).toEqual([
      [0, 0],
      [20, 0],
    ]);
    expect(code(() => extendCurve(line, edges, [1, 0]))).toBe('NO_CROSSING');
    expect(
      throughDistance(
        [
          [0, 0],
          [10, 0],
        ],
        false,
        [5, 3],
      ),
    ).toBe(3);
  });
});

describe('directions at the end of an arc', () => {
  it('are the exact tangents', () => {
    near(arcEndDirection([0, 0], [1, 0], [10, 10]), [0, 1]);
    near(arcThroughEndDirection([10, 0], [0, 10], [-10, 0]), [0, -1]);
    near(arcThroughEndDirection([-10, 0], [0, 10], [10, 0]), [0, -1]);
  });
});
