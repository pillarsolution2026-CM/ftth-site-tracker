import { describe, expect, it } from 'vitest';
import {
  boxOf,
  buildScene,
  cullEntities,
  entityBox,
  paperColor,
  resolveColor,
} from './drawing-scene';
import { entityAt, testView } from './drawing-test-view';

describe('drawing scene', () => {
  const view = testView();
  const scene = buildScene(view);

  it('computes a box per entity, including text reach', () => {
    expect(boxOf(scene, 0)).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 25 });
    const text = entityBox(entityAt(view, 3));
    expect(text.minX).toBeLessThan(30);
    expect(text.maxX).toBeGreaterThan(30);
  });

  it('indexes entities by handle and layers by name, origin at the extents centre', () => {
    expect(scene.byHandle.get('A1')).toEqual([2]);
    expect(scene.layerByName.get('CABINET')).toBe(2);
    expect(scene.origin).toEqual({ x: 50, y: 25 });
  });

  it('culls entities outside the visible rectangle', () => {
    const inside = cullEntities(scene, { minX: 60, minY: 20, maxX: 100, maxY: 30 });
    expect(inside).toEqual([1]);
    expect(cullEntities(scene, { minX: 500, minY: 500, maxX: 600, maxY: 600 })).toEqual([]);
    expect(cullEntities(scene, { minX: -1, minY: -1, maxX: 101, maxY: 51 })).toHaveLength(5);
  });

  it('resolves colour: own colour, else the layer, and the layer when moved', () => {
    const a = entityAt(view, 0);
    const b = entityAt(view, 1);
    expect(resolveColor(a, view.layers, 0, false)).toBe('#ff0000');
    expect(resolveColor(b, view.layers, 0, false)).toBe('#123456');
    expect(resolveColor(b, view.layers, 2, true)).toBe('#0000ff');
  });

  it('draws near-white strokes dark on the white paper', () => {
    expect(paperColor('#ffffff')).toBe('#333333');
    expect(paperColor('#ff0000')).toBe('#ff0000');
  });
});
