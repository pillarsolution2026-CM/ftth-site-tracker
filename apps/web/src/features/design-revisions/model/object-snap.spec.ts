import { describe, expect, it } from 'vitest';
import { EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import {
  centroid,
  circleOf3,
  DEFAULT_OSMODE,
  endDirection,
  findSnaps,
  modesOf,
  osmodeOf,
  overrideOf,
  SNAP_MODES,
  snapsAt,
  type SnapMode,
  type SnapShape,
} from './object-snap';

const only = (...modes: SnapMode[]) => new Set<SnapMode>(modes);
const first = (
  shapes: SnapShape[],
  cursor: [number, number],
  modes: Set<SnapMode>,
  anchor: [number, number] | null = null,
) => findSnaps(shapes, { cursor, aperture: 1, modes, anchor })[0];

const line: SnapShape = {
  kind: 'path',
  points: [
    [0, 0],
    [10, 0],
  ],
  closed: false,
};
const vertical: SnapShape = {
  kind: 'path',
  points: [
    [5, -5],
    [5, 5],
  ],
  closed: false,
};
const square: SnapShape = {
  kind: 'path',
  points: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  closed: true,
};
const circle: SnapShape = { kind: 'circle', center: [20, 0], radius: 5 };

describe('object snap modes (AutoCAD 2D)', () => {
  it('lists the 14 modes in the drop-down order, with OSMODE 4133 as the default', () => {
    expect(SNAP_MODES).toHaveLength(14);
    expect(SNAP_MODES[0]).toBe('endpoint');
    expect(SNAP_MODES[13]).toBe('parallel');
    expect([...modesOf(DEFAULT_OSMODE)].sort()).toEqual(
      ['center', 'endpoint', 'extension', 'intersection'].sort(),
    );
    expect(osmodeOf(modesOf(DEFAULT_OSMODE))).toBe(DEFAULT_OSMODE);
  });

  it('reads the typed one-time overrides', () => {
    expect(overrideOf('end')).toBe('endpoint');
    expect(overrideOf('_MIDpoint')).toBe('midpoint');
    expect(overrideOf('non')).toBe('none');
    expect(overrideOf('xx')).toBeNull();
    expect(overrideOf('LINE')).toBeNull();
  });

  it('Endpoint and Midpoint of a line', () => {
    expect(first([line], [9.5, 0.3], only('endpoint'))).toMatchObject({
      mode: 'endpoint',
      at: [10, 0],
    });
    expect(first([line], [5.2, 0.1], only('midpoint'))).toMatchObject({
      mode: 'midpoint',
      at: [5, 0],
    });
  });

  it('Center and Quadrant of a circle, Center found by hovering the curve', () => {
    expect(first([circle], [25.2, 0.5], only('center'))).toMatchObject({ at: [20, 0] });
    const q = first([circle], [20.3, 4.8], only('quadrant'));
    expect(q?.at[0]).toBeCloseTo(20);
    expect(q?.at[1]).toBeCloseTo(5);
  });

  it('Intersection of two crossing lines; not at the shared vertex of a polyline', () => {
    expect(first([line, vertical], [5.3, 0.2], only('intersection'))).toMatchObject({ at: [5, 0] });
    expect(first([square], [0.2, 0.2], only('intersection'))).toBeUndefined();
  });

  it('Geometric Center of a closed polyline, Node, Insertion', () => {
    expect(first([square], [3.8, 2], only('geometricCenter'))?.at).toEqual([2, 2]);
    expect(first([{ kind: 'node', at: [1, 1] }], [1.2, 1], only('node'))?.at).toEqual([1, 1]);
    expect(first([{ kind: 'insertion', at: [3, 3] }], [3, 3.5], only('insertion'))?.at).toEqual([
      3, 3,
    ]);
  });

  it('Perpendicular and Tangent from the last point', () => {
    expect(first([line], [3.1, 0.4], only('perpendicular'), [3, 8])?.at).toEqual([3, 0]);
    const tan = first([circle], [20, 5.3], only('tangent'), [20, 10]);
    expect(tan).toBeDefined();
    // The tangent point and the last point make a right angle at the circle.
    const [x, y] = tan?.at ?? [0, 0];
    expect((x - 20) * (20 - x) + y * (10 - y)).toBeCloseTo(0);
  });

  it('Nearest is ranked last; Extension and Parallel follow acquired lines', () => {
    const hits = findSnaps([line], {
      cursor: [9.6, 0.2],
      aperture: 1,
      modes: only('endpoint', 'nearest'),
      anchor: null,
    });
    expect(hits.map((h) => h.mode)).toEqual(['endpoint', 'nearest']);
    const ext = findSnaps([line], {
      cursor: [15, 0.3],
      aperture: 1,
      modes: only('extension'),
      anchor: null,
      acquired: [{ at: [10, 0], dir: endDirection([line], [10, 0]) }],
    })[0];
    expect(ext).toMatchObject({ mode: 'extension', from: [10, 0] });
    expect(ext?.at[0]).toBeCloseTo(15);
    const par = findSnaps([], {
      cursor: [5, 5.4],
      aperture: 1,
      modes: only('parallel'),
      anchor: [0, 5],
      parallels: [[1, 0]],
    })[0];
    expect(par?.at[1]).toBeCloseTo(5);
  });

  it('helpers: circle through 3 points, centroid', () => {
    const c = circleOf3([0, 1], [1, 0], [-1, 0]);
    expect(c?.center[0]).toBeCloseTo(0);
    expect(c?.radius).toBeCloseTo(1);
    expect(
      centroid([
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ]),
    ).toEqual([1, 1]);
  });

  it('snaps to the drawing: an endpoint of an entity, not to an erased one', () => {
    const scene = buildScene(testView());
    const source = { scene, preview: EMPTY_PREVIEW, isShown: () => true };
    const hits = snapsAt(source, {
      cursor: [99.5, 25.2],
      aperture: 1,
      modes: only('endpoint'),
      anchor: null,
    });
    expect(hits[0]?.at).toEqual([100, 25]);
    const erased = { ...EMPTY_PREVIEW, erased: new Set([1]) };
    expect(
      snapsAt(
        { ...source, preview: erased },
        { cursor: [99.5, 25.2], aperture: 1, modes: only('endpoint'), anchor: null },
      ),
    ).toEqual([]);
  });
});
