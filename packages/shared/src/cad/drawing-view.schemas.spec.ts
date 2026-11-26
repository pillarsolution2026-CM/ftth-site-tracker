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
