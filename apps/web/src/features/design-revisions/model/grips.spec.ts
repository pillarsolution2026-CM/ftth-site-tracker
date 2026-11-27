import type { DrawingViewEntity } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { applyInputs, EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import {
  circleThrough,
  geometryOf,
  objectName,
  polygonArea,
  polylineLength,
} from './entity-geometry';
import { GRIP_OBJECT_LIMIT, gripsOf, gripStretchEdits, hitGrip } from './grips';

const extra = (e: Partial<DrawingViewEntity> & { handle: string }): DrawingViewEntity => ({
  layer: 0,
  color: null,
  kind: 'LINE',
  paths: [],
  texts: [],
  ...e,
});
const circlePath = (cx: number, cy: number, r: number) =>
  Array.from({ length: 65 }, (_, i) => [
    cx + r * Math.cos((i / 64) * 2 * Math.PI),
    cy + r * Math.sin((i / 64) * 2 * Math.PI),
  ]).flat();

function scene() {
  const view = testView();
  view.entities.push(
    extra({ handle: 'C1', kind: 'CIRCLE', paths: [circlePath(10, 10, 5)] }),
    extra({
      handle: 'R1',
      kind: 'ARC',
      paths: [[15, 10, 10 + 5 * Math.SQRT1_2, 10 + 5 * Math.SQRT1_2, 10, 15]],
    }),
    extra({
      handle: 'K1',
      kind: 'INSERT',
      paths: [[60, 0, 62, 0]],
      insert: { x: 61, y: 1, rotation: 30, scaleX: 2, scaleY: 2, name: 'SAP' },
      texts: [{ x: 61, y: 3, height: 1, rotation: 0, text: 'S1' }],
    }),
  );
  return buildScene(view);
}
// 0 A polyline, 1 B line, 2 A1 insert (old view: no placement), 3 T1 text, 4 H1, 5 C1, 6 R1, 7 K1.

describe('entity geometry as AutoCAD knows it', () => {
  it('reads lines, polylines, circles, arcs, texts and block references', () => {
    const s = scene();
    const g = (i: number) => geometryOf(s, EMPTY_PREVIEW, i);
    expect(g(1)).toEqual({ type: 'line', start: { x: 50, y: 25 }, end: { x: 100, y: 25 } });
    expect(g(0)).toMatchObject({ type: 'polyline', closed: false });
    const circle = g(5);
    expect(circle?.type).toBe('circle');
    if (circle?.type === 'circle') {
      expect(circle.center.x).toBeCloseTo(10);
      expect(circle.radius).toBeCloseTo(5, 1);
    }
    const arc = g(6);
    expect(arc?.type).toBe('arc');
    if (arc?.type === 'arc') expect(arc.radius).toBeCloseTo(5);
    expect(g(3)).toMatchObject({ type: 'text', at: { x: 30, y: 30 }, text: 'F 36 C' });
    expect(g(7)).toMatchObject({
      type: 'insert',
      at: { x: 61, y: 1 },
      name: 'SAP',
      values: ['S1'],
    });
    expect(g(2)).toMatchObject({ type: 'insert', at: null, name: null });
    expect(objectName(g(7), 'INSERT')).toBe('Block Reference');
    expect(objectName(g(0), 'LWPOLYLINE')).toBe('Polyline');
  });

  it('follows moves and text changes not saved yet', () => {
    const s = scene();
    const shown = applyInputs(
      s,
      EMPTY_PREVIEW,
      [
        { kind: 'move_item', handle: 'T1', dx: 5, dy: 0 },
        { kind: 'set_text', handle: 'T1', text: 'NEW' },
      ],
      2.5,
    );
    expect(geometryOf(s, shown, 3)).toMatchObject({ at: { x: 35, y: 30 }, text: 'NEW' });
  });

  it('measures', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(polylineLength(square, true)).toBe(8);
    expect(polygonArea(square)).toBe(4);
    expect(circleThrough({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })?.radius).toBeCloseTo(1);
    expect(circleThrough({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });
});

describe('grips (owner 2026-11-26)', () => {
  it('a line has its ends and middle; a polyline its vertices and segment middles', () => {
    const s = scene();
    const line = gripsOf(s, EMPTY_PREVIEW, new Set([1]), true).grips;
    expect(line.map((g) => [g.kind, g.x, g.y])).toEqual([
      ['end', 50, 25],
      ['mid', 75, 25],
      ['end', 100, 25],
    ]);
    const pline = gripsOf(s, EMPTY_PREVIEW, new Set([0]), true).grips;
    expect(pline.map((g) => g.kind)).toEqual(['vertex', 'segment', 'vertex', 'segment', 'vertex']);
  });

  it('a circle has centre and quadrants; text and block ONE grip at the insertion point', () => {
    const s = scene();
    const circle = gripsOf(s, EMPTY_PREVIEW, new Set([5]), true).grips;
    expect(circle.map((g) => g.kind)).toEqual(['center', ...Array(4).fill('quadrant')]);
    expect(gripsOf(s, EMPTY_PREVIEW, new Set([3]), true).grips).toMatchObject([
      { kind: 'insert', x: 30, y: 30 },
    ]);
    expect(gripsOf(s, EMPTY_PREVIEW, new Set([7]), true).grips).toMatchObject([
      { kind: 'insert', x: 61, y: 1 },
    ]);
    // A view rendered before the placement was added: no grip rather than a made-up one.
    expect(gripsOf(s, EMPTY_PREVIEW, new Set([2]), true).grips).toEqual([]);
    // An arc's ends, middle and centre are all stretchable (round 3, audit 3).
    const arc = gripsOf(s, EMPTY_PREVIEW, new Set([6]), true).grips;
    expect(arc.filter((g) => g.editable).map((g) => g.kind)).toEqual([
      'end',
      'mid',
      'end',
      'center',
    ]);
  });

  it('a picked group or page block is one object with one grip in the middle of its box', () => {
    const s = scene();
    const grouped = applyInputs(
      s,
      EMPTY_PREVIEW,
      [{ kind: 'set_group', name: 'G', handles: ['B', 'T1'], block: false }],
      2.5,
    );
    const set = gripsOf(s, grouped, new Set([1, 3]), true);
    expect(set.grips).toHaveLength(1);
    expect(set.grips[0]).toMatchObject({ kind: 'group', handles: ['B', 'T1'] });
    expect(set.groupBoxes).toHaveLength(1);
    // Group selection off: each member shows its own grips; a page block stays one object.
    expect(gripsOf(s, grouped, new Set([1, 3]), false).grips.length).toBe(4);
    const blocked = applyInputs(
      s,
      EMPTY_PREVIEW,
      [{ kind: 'set_group', name: 'BK', handles: ['B', 'T1'], block: true }],
      2.5,
    );
    expect(gripsOf(s, blocked, new Set([1, 3]), false).grips).toHaveLength(1);
  });

  it('shows no grips above GRIPOBJLIMIT picked objects', () => {
    const view = testView({
      entities: Array.from({ length: GRIP_OBJECT_LIMIT + 1 }, (_, i) =>
        extra({ handle: `L${i}`, paths: [[i, 0, i, 1]] }),
      ),
    });
    const s = buildScene(view);
    const all = new Set(view.entities.map((_, i) => i));
    expect(gripsOf(s, EMPTY_PREVIEW, all, true).grips).toEqual([]);
  });

  it('finds the grip under the pointer', () => {
    const s = scene();
    const grips = gripsOf(s, EMPTY_PREVIEW, new Set([1]), true).grips;
    const identity = (x: number, y: number) => ({ x, y });
    expect(hitGrip(grips, identity, 74, 26, 5)?.kind).toBe('mid');
    expect(hitGrip(grips, identity, 60, 26, 5)).toBeNull();
  });

  it('STRETCH: an end moves alone, a segment middle moves both vertices, a centre moves', () => {
    const s = scene();
    const [end, mid] = gripsOf(s, EMPTY_PREVIEW, new Set([1]), true).grips;
    if (!end || !mid) throw new Error('grips');
    expect(gripStretchEdits(s, EMPTY_PREVIEW, end, end, { x: 50, y: 30 }, false, 'Route')).toEqual([
      {
        kind: 'set_curve',
        handle: 'B',
        points: [
          [50, 30],
          [100, 25],
        ],
        closed: false,
      },
    ]);
    expect(gripStretchEdits(s, EMPTY_PREVIEW, mid, mid, { x: 75, y: 35 }, false, 'Route')).toEqual([
      { kind: 'move_item', handle: 'B', dx: 0, dy: 10 },
    ]);
    const pline = gripsOf(s, EMPTY_PREVIEW, new Set([0]), true).grips;
    const segment = pline[1];
    if (!segment) throw new Error('segment');
    const [edit] =
      gripStretchEdits(s, EMPTY_PREVIEW, segment, segment, { x: 25, y: 5 }, false, 'Route') ?? [];
    expect(edit).toMatchObject({
      kind: 'set_curve',
      points: [
        [0, 5],
        [50, 5],
        [50, 25],
      ],
    });
    // Copy: the original stays, a new curve takes the change.
    expect(
      gripStretchEdits(s, EMPTY_PREVIEW, end, end, { x: 50, y: 30 }, true, 'Route')?.[0],
    ).toMatchObject({ kind: 'add_curve', layer: 'Route' });
  });

  it('STRETCH on a circle quadrant changes the radius', () => {
    const s = scene();
    const circle = gripsOf(s, EMPTY_PREVIEW, new Set([5]), true).grips;
    const quadrant = circle[1];
    if (!quadrant) throw new Error('quadrant');
    const [edit] =
      gripStretchEdits(s, EMPTY_PREVIEW, quadrant, quadrant, { x: 20, y: 10 }, false, '') ?? [];
    expect(edit?.kind).toBe('scale_item');
    if (edit?.kind === 'scale_item') expect(edit.factor).toBeCloseTo(2, 2);
    // An arc end: the arc now runs through the new end, its middle and its other end.
    const arcEnd = gripsOf(s, EMPTY_PREVIEW, new Set([6]), true).grips[0];
    if (!arcEnd) throw new Error('arc');
    const [arcEdit] =
      gripStretchEdits(s, EMPTY_PREVIEW, arcEnd, arcEnd, { x: 20, y: 10 }, false, '') ?? [];
    expect(arcEdit).toMatchObject({ kind: 'set_curve', handle: 'R1', closed: false });
    if (arcEdit?.kind === 'set_curve') {
      expect(arcEdit.arc).toBeDefined();
      expect(arcEdit.points[0]).toEqual([20, 10]);
      expect(arcEdit.points[arcEdit.points.length - 1]?.[0]).toBeCloseTo(10, 6);
      expect(arcEdit.points[arcEdit.points.length - 1]?.[1]).toBeCloseTo(15, 6);
    }
  });
});
