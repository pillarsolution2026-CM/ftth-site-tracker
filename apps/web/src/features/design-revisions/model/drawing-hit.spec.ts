import type { DrawingProblemView } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { buildMarkers, distToEntity, distToSegment, hitEntity, hitMarker } from './drawing-hit';
import { buildScene } from './drawing-scene';
import { entityAt, testView } from './drawing-test-view';

const view = testView();
const scene = buildScene(view);
const always = () => true;

describe('hit testing', () => {
  it('measures the distance to a segment, including past its ends', () => {
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(1, 1, 2, 2, 2, 2)).toBeCloseTo(Math.SQRT2);
  });

  it('measures the distance to the nearest path piece of an entity', () => {
    expect(distToEntity(entityAt(view, 0), 25, 4)).toBe(4);
    expect(distToEntity(entityAt(view, 0), 54, 12.5)).toBe(4);
  });

  it('treats the inside of a text box as a hit', () => {
    expect(distToEntity(entityAt(view, 3), 31, 31)).toBe(0);
  });

  it('picks the nearest entity within the tolerance', () => {
    expect(hitEntity(scene, 25, 1, 2, always)).toBe(0);
    expect(hitEntity(scene, 75, 24, 2, always)).toBe(1);
    expect(hitEntity(scene, 25, 10, 2, always)).toBeNull();
  });

  it('ignores entities that are not shown', () => {
    expect(hitEntity(scene, 25, 1, 2, (i) => i !== 0)).toBeNull();
    expect(hitEntity(scene, 50, 40, 1, (i) => i !== 4)).toBeNull();
  });

  it('builds a marker per place and marks corrected ones as fixed', () => {
    const problems = [
      {
        code: 'WRONG_LAYER',
        severity: 'warning',
        count: 2,
        items: [
          { handle: 'A1', drawingX: 21, drawingY: 21, layer: 'Sap', x: 1, y: 2 },
          { handle: 'B1', drawingX: 70, drawingY: 25, layer: 'Sap', x: 1, y: 2 },
        ],
      },
    ] as unknown as DrawingProblemView[];
    const markers = buildMarkers(problems, new Set(['WRONG_LAYER:A1']));
    expect(markers.map((m) => [m.handle, m.fixed])).toEqual([
      ['A1', true],
      ['B1', false],
    ]);
  });

  it('finds a marker by screen distance, a fixed size on screen', () => {
    const markers = buildMarkers(
      [
        {
          code: 'WRONG_LAYER',
          severity: 'warning',
          count: 1,
          items: [{ handle: 'A1', drawingX: 0, drawingY: 0, layer: 'Sap', x: 0, y: 0 }],
        },
      ] as unknown as DrawingProblemView[],
      new Set(),
    );
    const size = { width: 800, height: 600 };
    for (const scale of [0.5, 50]) {
      const tf = { cx: 0, cy: 0, scale };
      expect(hitMarker(markers, tf, size, 405, 303, 14)?.handle).toBe('A1');
      expect(hitMarker(markers, tf, size, 440, 300, 14)).toBeNull();
    }
  });
});
