import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  distanceToSegment,
  GeometryError,
  gripsOf,
  insertVertex,
  moveVertex,
  point,
  polylineLength,
  removeVertex,
  snap,
  SNAP_TOLERANCE_PX,
  toleranceFromPixels,
  translatePoint,
  translatePolyline,
  type Polyline,
  type SnapTarget,
} from './index.js';

// Qalyub sits in UTM 36N; realistic coordinates keep float behaviour honest.
const X0 = 331_000;
const Y0 = 3_342_000;
const [A, B, C] = [
  { x: X0, y: Y0 },
  { x: X0 + 30, y: Y0 + 40 },
  { x: X0 + 30, y: Y0 + 100 },
];
const route: Polyline = [A, B, C];

function expectGeometryError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GeometryError);
    expect((error as GeometryError).code).toBe(code);
    return;
  }
  throw new Error(`expected GeometryError ${code}`);
}

describe('polylineLength', () => {
  it('sums segment lengths in metres', () => {
    expect(polylineLength(route)).toBeCloseTo(110, 9);
  });

  it('rejects routes with fewer than two vertices', () => {
    expectGeometryError(() => polylineLength([{ x: X0, y: Y0 }]), 'TOO_FEW_VERTICES');
  });

  it('rejects non-finite coordinates', () => {
    expectGeometryError(
      () =>
        polylineLength([
          { x: X0, y: Y0 },
          { x: Number.NaN, y: Y0 },
        ]),
      'NON_FINITE_COORDINATE',
    );
    expectGeometryError(() => point(Infinity, 0), 'NON_FINITE_COORDINATE');
  });
});

describe('closestPointOnSegment', () => {
  it('projects onto the segment and clamps to its ends', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(closestPointOnSegment({ x: 4, y: 3 }, a, b)).toEqual({ x: 4, y: 0 });
    expect(closestPointOnSegment({ x: -5, y: 3 }, a, b)).toEqual(a);
    expect(closestPointOnSegment({ x: 15, y: 3 }, a, b)).toEqual(b);
    expect(closestPointOnSegment({ x: 1, y: 1 }, a, a)).toEqual(a);
  });
});

describe('translate', () => {
  it('moves points and routes', () => {
    expect(translatePoint({ x: 1, y: 2 }, 3, 4)).toEqual({ x: 4, y: 6 });
    expect(translatePolyline(route, 1, -1)[0]).toEqual({ x: X0 + 1, y: Y0 - 1 });
  });

  it('rejects a move that overflows', () => {
    expectGeometryError(
      () =>
        translatePolyline(
          [
            { x: Number.MAX_VALUE, y: 0 },
            { x: 0, y: 0 },
          ],
          Number.MAX_VALUE,
          0,
        ),
      'NON_FINITE_COORDINATE',
    );
  });
});

describe('grips', () => {
  it('gives a grip per vertex and per segment midpoint', () => {
    const grips = gripsOf(route);
    expect(grips.filter((g) => g.kind === 'vertex')).toHaveLength(3);
    expect(grips).toContainEqual({
      kind: 'midpoint',
      segmentIndex: 0,
      at: { x: X0 + 15, y: Y0 + 20 },
    });
    expect(grips).toContainEqual({
      kind: 'midpoint',
      segmentIndex: 1,
      at: { x: X0 + 30, y: Y0 + 70 },
    });
  });

  it('moves a vertex without mutating the input', () => {
    const moved = moveVertex(route, 1, { x: X0, y: Y0 + 40 });
    expect(polylineLength(moved)).toBeCloseTo(40 + Math.hypot(30, 60), 9);
    expect(route[1]).toEqual({ x: X0 + 30, y: Y0 + 40 });
  });

  it('inserts at the midpoint by default, or at a given point', () => {
    expect(insertVertex(route, 0)[1]).toEqual({ x: X0 + 15, y: Y0 + 20 });
    const bent = insertVertex(route, 1, { x: X0 + 50, y: Y0 + 70 });
    expect(bent).toHaveLength(4);
    expect(bent[2]).toEqual({ x: X0 + 50, y: Y0 + 70 });
  });

  it('removes a vertex but never below two', () => {
    expect(removeVertex(route, 1)).toEqual([route[0], route[2]]);
    expectGeometryError(() => removeVertex([A, B], 0), 'TOO_FEW_VERTICES');
  });

  it('rejects out-of-range indexes', () => {
    expectGeometryError(() => moveVertex(route, 3, A), 'VERTEX_OUT_OF_RANGE');
    expectGeometryError(() => moveVertex(route, 1.5, A), 'VERTEX_OUT_OF_RANGE');
    expectGeometryError(() => removeVertex(route, -1), 'VERTEX_OUT_OF_RANGE');
    expectGeometryError(() => insertVertex(route, 2), 'VERTEX_OUT_OF_RANGE');
  });
});

describe('snap', () => {
  const targets: SnapTarget[] = [
    { featureId: 'cable-1', kind: 'route', vertices: route },
    { featureId: 'box-1-1', kind: 'symbol', at: { x: X0 + 30, y: Y0 + 45 } },
  ];

  it('converts the 14px screen margin to metres', () => {
    expect(SNAP_TOLERANCE_PX).toBe(14);
    expect(toleranceFromPixels(SNAP_TOLERANCE_PX, 0.5)).toBe(7);
    expectGeometryError(() => toleranceFromPixels(14, -1), 'INVALID_TOLERANCE');
  });

  it('snaps to the nearest endpoint, vertex or symbol', () => {
    expect(snap({ x: X0 + 1, y: Y0 + 1 }, targets, 5)).toMatchObject({
      featureId: 'cable-1',
      kind: 'endpoint',
      vertexIndex: 0,
    });
    expect(snap({ x: X0 + 29, y: Y0 + 41 }, targets, 5)).toMatchObject({
      kind: 'vertex',
      vertexIndex: 1,
    });
    expect(snap({ x: X0 + 30, y: Y0 + 44 }, targets, 5)).toMatchObject({
      featureId: 'box-1-1',
      kind: 'symbol',
    });
  });

  it('returns null outside the tolerance and includes the boundary', () => {
    expect(snap({ x: X0 - 6, y: Y0 }, targets, 5)).toBeNull();
    expect(snap({ x: X0 - 5, y: Y0 }, targets, 5)).toMatchObject({ distance: 5 });
  });

  it('prefers endpoint, then symbol, then vertex on a tie', () => {
    const tied: SnapTarget[] = [
      {
        featureId: 'a',
        kind: 'route',
        vertices: [
          { x: -1, y: 0 },
          { x: 0, y: 0 },
          { x: 1, y: 5 },
        ],
      },
      { featureId: 'b', kind: 'symbol', at: { x: 0, y: 0 } },
      {
        featureId: 'c',
        kind: 'route',
        vertices: [
          { x: 0, y: 0 },
          { x: 9, y: 9 },
        ],
      },
    ];
    expect(snap({ x: 0, y: 0 }, tied, 1)).toMatchObject({ featureId: 'c', kind: 'endpoint' });
    expect(snap({ x: 0, y: 0 }, tied.slice(0, 2), 1)).toMatchObject({
      featureId: 'b',
      kind: 'symbol',
    });
  });

  it('never snaps to what is being dragged', () => {
    const cursor = { x: X0 + 30, y: Y0 + 40 };
    expect(
      snap(cursor, targets, 1, { exclude: { featureId: 'cable-1', vertexIndex: 1 } }),
    ).toBeNull();
    expect(
      snap({ x: X0 + 30, y: Y0 + 45 }, targets, 1, { exclude: { featureId: 'box-1-1' } }),
    ).toBeNull();
    expect(snap({ x: X0, y: Y0 }, targets, 1, { exclude: { featureId: 'cable-1' } })).toBeNull();
    // Other vertices of the dragged route are still valid targets (closing a ring, aligning).
    expect(
      snap({ x: X0, y: Y0 }, targets, 1, { exclude: { featureId: 'cable-1', vertexIndex: 1 } }),
    ).toMatchObject({
      vertexIndex: 0,
    });
  });

  it('rejects an invalid tolerance or cursor', () => {
    expectGeometryError(() => snap({ x: 0, y: 0 }, targets, Number.NaN), 'INVALID_TOLERANCE');
    expectGeometryError(() => snap({ x: Number.NaN, y: 0 }, targets, 1), 'NON_FINITE_COORDINATE');
  });
});

describe('distanceToSegment', () => {
  it('measures to the nearest point of the segment', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment({ x: 4, y: 3 }, a, b)).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
    expect(distanceToSegment({ x: 5, y: 0 }, a, b)).toBe(0);
  });
});
