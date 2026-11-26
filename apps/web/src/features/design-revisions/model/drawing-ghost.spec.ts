import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translation } from './affine';
import { drawOverlay, PathCache, type DrawModel } from './drawing-draw';
import { EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { createMockContext, FakePath2D } from './mock-canvas';
import { perfView } from './perf-scene';

/** Round 2, items 26 / 30: the ghost of a MOVE stays light on a big selection. */
beforeEach(() => {
  vi.stubGlobal('Path2D', FakePath2D);
});

const scene = buildScene(perfView(20_000, 1000));
const vp = { width: 800, height: 600, dpr: 1 };
const asCtx = (ctx: ReturnType<typeof createMockContext>) =>
  ctx as unknown as CanvasRenderingContext2D;
const model = (indexes: number[]): DrawModel => ({
  scene,
  preview: EMPTY_PREVIEW,
  layerShown: () => true,
  markers: [],
  highlighted: new Set(),
  selected: null,
  ghost: { indexes, step: translation(10, 5) },
});

describe('the ghost of a MOVE', () => {
  it('moves the whole selection with one transform and strokes only what is on the screen', () => {
    const ctx = createMockContext();
    const all = scene.view.entities.map((_, i) => i);
    // The window shows 100 × 75 units of the 1000 × 1000 drawing.
    drawOverlay(asCtx(ctx), model(all), new PathCache(scene), { cx: 500, cy: 500, scale: 8 }, vp);
    expect(ctx.stroke.mock.calls.length).toBeGreaterThan(0);
    expect(ctx.stroke.mock.calls.length).toBeLessThan(400);
    // One transform for all the strokes, not one per entity.
    expect(ctx.transform.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('never strokes more than a few thousand paths a frame, however many are picked', () => {
    const ctx = createMockContext();
    const all = scene.view.entities.map((_, i) => i);
    drawOverlay(asCtx(ctx), model(all), new PathCache(scene), { cx: 500, cy: 500, scale: 0.8 }, vp);
    expect(ctx.stroke.mock.calls.length).toBeLessThanOrEqual(3000);
    // A selection that big gets one box, not one per object.
    expect(ctx.strokeRect.mock.calls.length).toBeLessThan(10);
  });

  it('draws the picked objects one box each when they are few', () => {
    const ctx = createMockContext();
    drawOverlay(
      asCtx(ctx),
      model([0, 1, 2]),
      new PathCache(scene),
      { cx: 500, cy: 500, scale: 0.8 },
      vp,
    );
    expect(ctx.strokeRect.mock.calls.length).toBeGreaterThan(0);
    expect(ctx.strokeRect.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
