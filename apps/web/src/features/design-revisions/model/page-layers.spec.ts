import type { DrawingCorrection } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromNamed, toNamed } from '../hooks/use-layer-screen';
import { drawBase, PathCache, type DrawModel } from './drawing-draw';
import { applyCorrections } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import { createMockContext, FakePath2D } from './mock-canvas';

/**
 * Layers made on the page (audit 7): they get an index after the drawing's ones, so they are
 * turned off / frozen / locked and coloured on the screen; layer states are kept by NAME.
 */

beforeEach(() => {
  vi.stubGlobal('Path2D', FakePath2D);
});

const scene = buildScene(testView());
const vp = { width: 800, height: 600, dpr: 1 };
const PAGE = scene.view.layers.length; // HOUSES, made on the page

const row = (n: number, correction: DrawingCorrection['correction']): DrawingCorrection => ({
  id: `4444444${n}-4444-4444-8444-444444444444`,
  cadFileId: scene.view.cadFileId,
  correction,
  problem: null,
  createdBy: null,
  createdAt: '2026-11-26T10:00:00+00:00',
  withdrawnBy: null,
  withdrawnAt: null,
});

const preview = applyCorrections(
  scene,
  [
    row(1, { kind: 'add_layer', layer: 'HOUSES', like: null }),
    row(2, {
      kind: 'add_curve',
      layer: 'HOUSES',
      points: [
        [10, 10],
        [20, 10],
      ],
      closed: false,
    }),
  ],
  2.5,
);

function draw(shown: (index: number) => boolean, layerColor?: Map<number, string>) {
  const ctx = createMockContext();
  const model: DrawModel = {
    scene,
    preview,
    // Only HOUSES and the drawing's layers that are visible.
    layerShown: shown,
    pageLayer: (name) => (name === 'HOUSES' ? PAGE : -1),
    layerColor,
    markers: [],
    highlighted: new Set(),
    selected: null,
  };
  drawBase(
    ctx as unknown as CanvasRenderingContext2D,
    model,
    new PathCache(scene),
    { cx: 15, cy: 10, scale: 20 },
    vp,
  );
  return ctx;
}

describe('layers made on the page (audit 7)', () => {
  it('the preview keeps them without a view index; the screen state applies by name', () => {
    expect(preview.extraCurves[0]).toMatchObject({ layer: -1, layerName: 'HOUSES' });
    const asked: number[] = [];
    draw((index) => {
      asked.push(index);
      return true;
    });
    expect(asked).toContain(PAGE);
    expect(asked).not.toContain(-1);
  });

  it('a frozen page layer is not drawn', () => {
    const on = draw(() => true, new Map([[PAGE, '#ff00ff']]));
    const strokes = (ctx: ReturnType<typeof createMockContext>) => ctx.stroke.mock.calls.length;
    const off = draw((index) => index !== PAGE);
    expect(strokes(off)).toBeLessThan(strokes(on));
  });
});

describe('layer states by name (audit 7)', () => {
  const names = ['Route', 'Sap', 'CABINET', 'Hidden', 'HOUSES'];
  const nameOf = (i: number) => names[i] ?? '';

  it('saves names and restores them to the indexes of today', () => {
    const named = toNamed(
      { overrides: new Map([[1, false]]), frozen: new Set([4]), locked: new Set([0]) },
      nameOf,
    );
    expect(named).toEqual({ overrides: [['Sap', false]], frozen: ['HOUSES'], locked: ['Route'] });
    // HOUSES is now at another index; a layer that is gone is left out.
    const today = ['Route', 'HOUSES', 'Sap'];
    const back = fromNamed({ ...named, locked: ['Route', 'GONE'] }, (n) => today.indexOf(n));
    expect(back).toEqual({
      overrides: new Map([[2, false]]),
      frozen: new Set([1]),
      locked: new Set([0]),
    });
  });

  it('still loads states saved by index before', () => {
    expect(fromNamed({ overrides: [[3, true]], frozen: [2], locked: [] }, () => -1)).toEqual({
      overrides: new Map([[3, true]]),
      frozen: new Set([2]),
      locked: new Set(),
    });
    expect(fromNamed('junk', () => -1)).toBeNull();
  });
});
