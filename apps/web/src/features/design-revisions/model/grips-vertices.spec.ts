import type { DrawingViewEntity } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { bulgeThrough, flattenVertices, segmentMid, transformVertices } from './bulge';
import { applyInputs, EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import { geometryOf } from './entity-geometry';
import { gripsOf, gripsStretchEdits, type Grip } from './grips';

/**
 * Round 3, phase 2B (ADR-062, owner item 33): grips on a polyline's real vertices and on the
 * middle of its arc segments, bulges kept, arcs / several hot grips stretched as AutoCAD does.
 */

const extra = (e: Partial<DrawingViewEntity> & { handle: string }): DrawingViewEntity => ({
  layer: 0,
  color: null,
  kind: 'LWPOLYLINE',
  paths: [],
  texts: [],
  ...e,
});

// A polyline 0,0 → 10,0 → (half circle, counter-clockwise) → 10,10 → 0,10.
const VERTICES = [
  { x: 0, y: 0, bulge: 0 },
  { x: 10, y: 0, bulge: 1 },
  { x: 10, y: 10, bulge: 0 },
  { x: 0, y: 10, bulge: 0 },
];

function scene() {
  const view = testView();
  const path = flattenVertices(VERTICES, false).flat();
  view.entities.push(
    extra({ handle: 'P9', paths: [path], vertices: VERTICES, closed: false }),
    extra({
      handle: 'A9',
      kind: 'ARC',
      paths: [[5, 0, 0, 5, -5, 0]],
      arc: { x: 0, y: 0, r: 5, start: 0, end: 180 },
    }),
    extra({
      handle: 'E9',
      kind: 'ELLIPSE',
      paths: [[4, 0, 0, 2, -4, 0, 0, -2, 4, 0]],
      ellipse: { x: 0, y: 0, majorX: 4, majorY: 0, ratio: 0.5, start: 0, end: 2 * Math.PI },
    }),
  );
  const s = buildScene(view);
  const index = (handle: string) => [...(s.byHandle.get(handle) ?? [])][0] as number;
  return { s, poly: index('P9'), arc: index('A9'), ellipse: index('E9') };
}

describe('bulges (ADR-062)', () => {
  it('finds the middle of an arc segment and the bulge through a point', () => {
    expect(segmentMid({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)).toEqual({ x: 1, y: -1 });
    expect(segmentMid({ x: 0, y: 0 }, { x: 2, y: 0 }, 0)).toEqual({ x: 1, y: 0 });
    expect(bulgeThrough({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: -1 })).toBeCloseTo(1, 9);
    expect(bulgeThrough({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(-1, 9);
    expect(bulgeThrough({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: -0.5 })).toBeCloseTo(0.5, 9);
    expect(bulgeThrough({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });

  it('flattens arc segments onto their circle and keeps straight ones', () => {
    const points = flattenVertices(VERTICES, false);
    expect(points[0]).toEqual([0, 0]);
    expect(points[points.length - 1]).toEqual([0, 10]);
    const arc = points.filter(([x]) => x > 10 + 1e-9);
    expect(arc.length).toBeGreaterThan(10);
    for (const [x, y] of arc) expect(Math.hypot(x - 10, y - 5)).toBeCloseTo(5, 9);
  });

  it('turns the arcs round when mirrored', () => {
    const mirrored = transformVertices(VERTICES, [-1, 0, 0, 1, 0, 0]);
    expect(mirrored[1]).toEqual({ x: -10, y: 0, bulge: -1 });
  });
});

describe('grips on real vertices (item 33)', () => {
  it('puts a grip on each vertex and on the middle of each segment, the arc one on the arc', () => {
    const { s, poly } = scene();
    const grips = gripsOf(s, EMPTY_PREVIEW, new Set([poly]), true).grips;
    expect(grips.filter((g) => g.kind === 'vertex')).toHaveLength(4);
    const segments = grips.filter((g) => g.kind === 'segment');
    expect(segments.map((g) => [g.x, g.y])).toEqual([
      [5, 0],
      [15, 5],
      [5, 10],
    ]);
  });

  it('stretches a vertex and keeps the bulges; the arc middle bends the arc', () => {
    const { s, poly } = scene();
    const grips = gripsOf(s, EMPTY_PREVIEW, new Set([poly]), true).grips;
    const vertex = grips.find((g) => g.kind === 'vertex' && g.vertex === 3) as Grip;
    const [edit] =
      gripsStretchEdits(s, EMPTY_PREVIEW, [vertex], vertex, { x: -5, y: 10 }, false, () => '') ??
      [];
    expect(edit).toMatchObject({
      kind: 'set_curve',
      handle: 'P9',
      vertices: [
        [0, 0, 0],
        [10, 0, 1],
        [10, 10, 0],
        [-5, 10, 0],
      ],
    });
    const arcMid = grips.find((g) => g.kind === 'segment' && g.vertex === 1) as Grip;
    const [bent] =
      gripsStretchEdits(s, EMPTY_PREVIEW, [arcMid], arcMid, { x: 12, y: 5 }, false, () => '') ??
      [];
    expect(bent?.kind).toBe('set_curve');
    if (bent?.kind === 'set_curve') {
      const b = bent.vertices?.[1]?.[2] ?? 0;
      expect(b).toBeCloseTo(0.4, 6);
      expect(bent.vertices?.[0]).toEqual([0, 0, 0]);
    }
  });

  it('the grips follow a grip edit not saved yet, on the new vertices', () => {
    const { s, poly } = scene();
    const shown = applyInputs(
      s,
      EMPTY_PREVIEW,
      [
        {
          kind: 'set_curve',
          handle: 'P9',
          points: [
            [0, 0],
            [20, 0],
          ],
          closed: false,
          vertices: [
            [0, 0, 0],
            [20, 0, 0],
          ],
        },
        { kind: 'move_item', handle: 'P9', dx: 0, dy: 5 },
      ],
      2.5,
    );
    expect(geometryOf(s, shown, poly)).toMatchObject({
      type: 'polyline',
      vertices: [
        { x: 0, y: 5, bulge: 0 },
        { x: 20, y: 5, bulge: 0 },
      ],
    });
  });

  it('several hot grips move together (Shift+click)', () => {
    const { s, poly } = scene();
    const grips = gripsOf(s, EMPTY_PREVIEW, new Set([poly]), true).grips;
    const hot = grips.filter((g) => g.kind === 'vertex' && (g.vertex === 0 || g.vertex === 3));
    const base = hot[0] as Grip;
    const [edit] =
      gripsStretchEdits(s, EMPTY_PREVIEW, hot, base, { x: -2, y: 0 }, false, () => '') ?? [];
    expect(edit).toMatchObject({
      vertices: [
        [-2, 0, 0],
        [10, 0, 1],
        [10, 10, 0],
        [-2, 10, 0],
      ],
    });
  });
});

describe('arcs and ellipses from the view (ADR-062)', () => {
  it('reads the true arc and ellipse; arc grips stretch through the three grips', () => {
    const { s, arc, ellipse } = scene();
    expect(geometryOf(s, EMPTY_PREVIEW, arc)).toMatchObject({
      type: 'arc',
      center: { x: 0, y: 0 },
      radius: 5,
    });
    expect(geometryOf(s, EMPTY_PREVIEW, ellipse)).toMatchObject({
      type: 'ellipse',
      center: { x: 0, y: 0 },
      major: [
        { x: 4, y: 0 },
        { x: -4, y: 0 },
      ],
      minor: [
        { x: 0, y: 2 },
        { x: 0, y: -2 },
      ],
    });
    const grips = gripsOf(s, EMPTY_PREVIEW, new Set([arc]), true).grips;
    const mid = grips.find((g) => g.kind === 'mid') as Grip;
    expect(mid.x).toBeCloseTo(0, 9);
    expect(mid.y).toBeCloseTo(5, 9);
    const [edit] =
      gripsStretchEdits(s, EMPTY_PREVIEW, [mid], mid, { x: 0, y: 2 }, false, () => '') ?? [];
    expect(edit?.kind).toBe('set_curve');
    if (edit?.kind === 'set_curve') {
      // Through (5, 0), (0, 2), (-5, 0): centre (0, -5.25), radius 7.25.
      expect(edit.arc?.y).toBeCloseTo(-5.25, 6);
      expect(edit.arc?.r).toBeCloseTo(7.25, 6);
      expect(edit.points[0]).toEqual([5, 0]);
    }
  });
});
