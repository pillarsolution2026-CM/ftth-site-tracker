import { describe, expect, it } from 'vitest';
import { distToEntity, hitEntity } from './drawing-hit';
import { boxOf, buildScene } from './drawing-scene';
import { entityGridOf } from './entity-grid';
import { perfView } from './perf-scene';

const scene = buildScene(perfView(3000, 1000));

describe('entity grid', () => {
  it('finds exactly the entities whose box meets the query box', () => {
    const grid = entityGridOf(scene);
    for (const box of [
      { minX: 100, minY: 100, maxX: 180, maxY: 160 },
      { minX: -50, minY: -50, maxX: 20, maxY: 20 },
      { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      { minX: 990, minY: 400, maxX: 2000, maxY: 410 },
    ]) {
      const brute: number[] = [];
      for (let i = 0; i < scene.view.entities.length; i++) {
        const b = boxOf(scene, i);
        if (b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY) {
          brute.push(i);
        }
      }
      expect([...grid.query(box)]).toEqual(brute);
    }
  });

  it('is built once per scene', () => {
    expect(entityGridOf(scene)).toBe(entityGridOf(scene));
  });

  it('hit test gives the same answer as walking every entity', () => {
    for (let n = 0; n < 40; n++) {
      const x = (n * 97) % 1000;
      const y = (n * 211) % 1000;
      const tolerance = 4 + (n % 5) * 3;
      let best: number | null = null;
      let bestDistance = tolerance;
      scene.view.entities.forEach((entity, i) => {
        const d = distToEntity(entity, x, y);
        if (d <= bestDistance) {
          best = i;
          bestDistance = d;
        }
      });
      expect(hitEntity(scene, x, y, tolerance, () => true)).toBe(best);
    }
  });
});
