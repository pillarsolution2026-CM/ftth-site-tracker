import { describe, expect, it } from 'vitest';
import { DrawingViewEntitySchema } from './drawing-view.schemas.js';

const entity = {
  handle: 'A1',
  layer: 0,
  color: null,
  kind: 'INSERT',
  paths: [[0, 0, 1, 1]],
  texts: [],
};

describe('DrawingViewEntitySchema insert (owner 2026-11-26)', () => {
  it('reads an INSERT placement, and a view rendered before it (no insert)', () => {
    const insert = { x: 1, y: 2, rotation: 90, scaleX: 2, scaleY: 2, name: 'SYM' };
    expect(DrawingViewEntitySchema.parse({ ...entity, insert }).insert).toEqual(insert);
    expect(DrawingViewEntitySchema.parse(entity).insert).toBeUndefined();
  });

  it('refuses a non-finite placement and a too long block name', () => {
    const insert = { x: 1, y: 2, rotation: 0, scaleX: 1, scaleY: 1, name: 'B' };
    expect(
      DrawingViewEntitySchema.safeParse({ ...entity, insert: { ...insert, x: Infinity } }).success,
    ).toBe(false);
    expect(
      DrawingViewEntitySchema.safeParse({ ...entity, insert: { ...insert, name: 'x'.repeat(256) } })
        .success,
    ).toBe(false);
  });
});

describe('DrawingViewEntitySchema vertices / arc / ellipse (ADR-062, item 33)', () => {
  const pline = { ...entity, kind: 'LWPOLYLINE' };
  it('reads real vertices with bulges, and views rendered before keep working (none)', () => {
    const vertices = [
      { x: 0, y: 0, bulge: 1 },
      { x: 2, y: 0, bulge: 0 },
      { x: 2, y: 2, bulge: -0.5 },
    ];
    const parsed = DrawingViewEntitySchema.parse({ ...pline, vertices, closed: true });
    expect(parsed.vertices).toEqual(vertices);
    expect(parsed.closed).toBe(true);
    const before = DrawingViewEntitySchema.parse(pline);
    expect(before.vertices).toBeUndefined();
    expect(before.closed).toBeUndefined();
  });

  it('refuses one vertex, a non-finite or huge bulge', () => {
    const ok = (vertices: unknown) =>
      DrawingViewEntitySchema.safeParse({ ...pline, vertices }).success;
    expect(ok([{ x: 0, y: 0, bulge: 0 }])).toBe(false);
    expect(
      ok([
        { x: 0, y: 0, bulge: NaN },
        { x: 1, y: 0, bulge: 0 },
      ]),
    ).toBe(false);
    expect(
      ok([
        { x: 0, y: 0, bulge: 1001 },
        { x: 1, y: 0, bulge: 0 },
      ]),
    ).toBe(false);
    expect(
      ok([
        { x: 0, y: 0, bulge: -1000 },
        { x: 1, y: 0, bulge: 0 },
      ]),
    ).toBe(true);
  });

  it('reads a circle / arc and an ellipse; refuses a zero radius and a bad ratio', () => {
    const arc = { x: 1, y: 2, r: 3, start: 10, end: 100 };
    expect(DrawingViewEntitySchema.parse({ ...entity, kind: 'ARC', arc }).arc).toEqual(arc);
    expect(
      DrawingViewEntitySchema.safeParse({ ...entity, kind: 'ARC', arc: { ...arc, r: 0 } }).success,
    ).toBe(false);
    const ellipse = { x: 0, y: 0, majorX: 4, majorY: 0, ratio: 0.5, start: 0, end: 6.283 };
    expect(DrawingViewEntitySchema.parse({ ...entity, kind: 'ELLIPSE', ellipse }).ellipse).toEqual(
      ellipse,
    );
    expect(
      DrawingViewEntitySchema.safeParse({ ...entity, ellipse: { ...ellipse, ratio: 1.5 } }).success,
    ).toBe(false);
  });
});
