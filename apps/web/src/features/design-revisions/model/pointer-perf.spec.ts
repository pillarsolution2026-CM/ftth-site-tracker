import { describe, expect, it } from 'vitest';
import { hitEntity } from './drawing-hit';
import { EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { entityGridOf } from './entity-grid';
import { snapsAt, type SnapMode } from './object-snap';
import { perfView } from './perf-scene';

/**
 * Round 2, items 26 / 30: the pointer must stay smooth on a large drawing at any zoom. The
 * budgets are generous (a slow CI machine) but far below the seconds the freeze took.
 */
const ALL_MODES = new Set<SnapMode>([
  'endpoint',
  'midpoint',
  'center',
  'geometricCenter',
  'node',
  'quadrant',
  'intersection',
  'extension',
  'insertion',
  'perpendicular',
  'tangent',
  'nearest',
  'apparentIntersection',
  'parallel',
]);

const scene = buildScene(perfView(60_000));
const source = { scene, preview: EMPTY_PREVIEW, isShown: () => true };

function slowest(runs: number, work: (i: number) => void): number {
  let worst = 0;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    work(i);
    worst = Math.max(worst, performance.now() - start);
  }
  return worst;
}

describe('pointer work on a large drawing (60 000 objects)', () => {
  // Zoomed far out: 10 px of aperture is thousands of drawing units.
  for (const scale of [0.2, 0.02, 0.004]) {
    it(`object snap with every mode stays under budget at ${scale} px/unit`, () => {
      const aperture = 10 / scale;
      entityGridOf(scene); // built once per drawing, as the viewer does on load
      const worst = slowest(10, (i) => {
        snapsAt(source, {
          cursor: [3000 + i * 531, 4000 + i * 377],
          aperture,
          modes: ALL_MODES,
          anchor: [5000, 5000],
        });
      });
      expect(worst).toBeLessThan(100);
    });
  }

  it('hit test stays under budget far out', () => {
    entityGridOf(scene);
    const worst = slowest(20, (i) => {
      hitEntity(scene, 2000 + i * 400, 3000 + i * 250, 10 / 0.004, () => true);
    });
    expect(worst).toBeLessThan(60);
  });
});
