import { beforeAll, describe, expect, it } from 'vitest';
import { translation } from './affine';
import {
  CHOSEN_MAX_STROKES,
  drawBase,
  drawOverlay,
  PathCache,
  SelectionLayer,
  viewShift,
  type DrawModel,
} from './drawing-draw';
import { EMPTY_PREVIEW, type DrawingPreview } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { entityGridOf } from './entity-grid';
import { createMockContext, FakePath2D } from './mock-canvas';
import { snapsAt, type SnapMode } from './object-snap';
import { perfCopies, perfView } from './perf-scene';
import type { ViewTransform } from './view-transform';

/**
 * Round 3, audit section 10 (freeze-class): the work of a pointer frame is bounded whatever the
 * size of the drawing or of the selection. The checks count canvas calls, not only time.
 */
beforeAll(() => {
  // Path2D does not exist in jsdom.
  globalThis.Path2D = FakePath2D as unknown as typeof Path2D;
});

const COUNT = 50_000;
const scene = buildScene(perfView(COUNT));
const vp = { width: 1200, height: 800, dpr: 1 };
/** The whole 10 000 × 10 000 drawing on the screen (ZOOM Extents). */
const extents: ViewTransform = { cx: 5000, cy: 5000, scale: 0.08 };
const all = new Set(Array.from({ length: COUNT }, (_, i) => i));

function modelOf(chosen: ReadonlySet<number>, preview: DrawingPreview = EMPTY_PREVIEW): DrawModel {
  return {
    scene,
    preview,
    layerShown: () => true,
    markers: [],
    highlighted: new Set(),
    selected: null,
    chosen,
  };
}

/** A layer whose bitmap is a canvas with a counting context. */
function layer() {
  const ctx = createMockContext();
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { selection: new SelectionLayer(() => canvas), ctx };
}

describe('Ctrl+A then MOVE on 50 000 objects (audit 10.1)', () => {
  it('strokes the selection once; each pointer frame only copies bitmaps', () => {
    const cache = new PathCache(scene);
    const { selection, ctx: layerCtx } = layer();
    const ctx = createMockContext();
    const indexes = [...all];
    const model = modelOf(all);
    const frames = 60;
    let worst = 0;
    for (let i = 0; i < frames; i++) {
      const start = performance.now();
      drawOverlay(
        ctx as unknown as CanvasRenderingContext2D,
        { ...model, ghost: { indexes, step: translation(i * 13, i * 7) } },
        cache,
        extents,
        vp,
        { selection },
      );
      // The first frame draws the selection layer once; the following ones are the drag.
      if (i > 0) worst = Math.max(worst, performance.now() - start);
    }
    expect(selection.renders).toBe(1);
    expect(layerCtx.stroke.mock.calls.length).toBeLessThanOrEqual(CHOSEN_MAX_STROKES);
    // No entity stroked on the frames: the selection and its ghost are bitmaps.
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalledTimes(frames * 2);
    // The ghost of a big selection has one box for all.
    expect(ctx.strokeRect.mock.calls.length).toBeLessThanOrEqual(frames);
    expect(worst).toBeLessThan(50);
  });

  it('a small selection keeps its exact ghost; the selection is still stroked once', () => {
    const cache = new PathCache(scene);
    const { selection } = layer();
    const ctx = createMockContext();
    const few = new Set([...all].slice(0, 500));
    const model = modelOf(few);
    for (let i = 0; i < 20; i++) {
      drawOverlay(
        ctx as unknown as CanvasRenderingContext2D,
        { ...model, ghost: { indexes: [...few], step: translation(i, 0) } },
        cache,
        extents,
        vp,
        { selection },
      );
    }
    expect(selection.renders).toBe(1);
    // Only the ghost is stroked per frame (the 500 entities, culled), never the selection again.
    expect(ctx.stroke.mock.calls.length).toBeLessThanOrEqual(20 * 500);
  });

  it('redraws the selection when it changes, not when the pointer moves', () => {
    const cache = new PathCache(scene);
    const { selection } = layer();
    const ctx = createMockContext() as unknown as CanvasRenderingContext2D;
    const one = new Set([1, 2, 3]);
    drawOverlay(ctx, modelOf(one), cache, extents, vp, { selection });
    drawOverlay(ctx, modelOf(one), cache, extents, vp, { selection });
    expect(selection.renders).toBe(1);
    drawOverlay(ctx, modelOf(new Set([1, 2])), cache, extents, vp, { selection });
    expect(selection.renders).toBe(2);
  });

  it('is culled to the screen and capped when zoomed in', () => {
    const cache = new PathCache(scene);
    const { selection, ctx: layerCtx } = layer();
    const ctx = createMockContext() as unknown as CanvasRenderingContext2D;
    const near: ViewTransform = { cx: 5000, cy: 5000, scale: 2 };
    drawOverlay(ctx, modelOf(all), cache, near, vp, { selection });
    // 600 × 400 units of a 10 000 square: a few hundred objects, not 50 000.
    expect(layerCtx.stroke.mock.calls.length).toBeLessThan(COUNT / 50);
  });

  it('during a pan or wheel burst moves the bitmap; at rest draws it exactly', () => {
    const cache = new PathCache(scene);
    const { selection } = layer();
    const ctx = createMockContext();
    const model = modelOf(all);
    const c = ctx as unknown as CanvasRenderingContext2D;
    drawOverlay(c, model, cache, extents, vp, { selection });
    for (let i = 1; i <= 10; i++) {
      const tf = { cx: 5000 + i * 20, cy: 5000, scale: 0.08 * 1.1 ** i };
      drawOverlay(c, model, cache, tf, vp, { selection, fast: true });
    }
    expect(selection.renders).toBe(1);
    drawOverlay(c, model, cache, { cx: 5200, cy: 5000, scale: 0.2 }, vp, { selection });
    expect(selection.renders).toBe(2);
  });
});

describe('2 000 copies on the page (audit 10.2 / 10.1)', () => {
  const preview: DrawingPreview = { ...EMPTY_PREVIEW, copies: perfCopies(COUNT, 2000) };

  it('the overlay frame strokes none of the copies (they are in the base)', () => {
    const cache = new PathCache(scene);
    const ctx = createMockContext();
    for (let i = 0; i < 30; i++) {
      drawOverlay(
        ctx as unknown as CanvasRenderingContext2D,
        modelOf(new Set(), preview),
        cache,
        extents,
        vp,
      );
    }
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('the base skips moved objects that are now off the screen', () => {
    const cache = new PathCache(scene);
    const near: ViewTransform = { cx: 5000, cy: 5000, scale: 2 };
    const count = (transformOf: DrawingPreview['transformOf']) => {
      const ctx = createMockContext();
      drawBase(
        ctx as unknown as CanvasRenderingContext2D,
        modelOf(new Set(), { ...EMPTY_PREVIEW, transformOf }),
        cache,
        near,
        vp,
      );
      return ctx.stroke.mock.calls.length + ctx.save.mock.calls.length;
    };
    const still = count(new Map());
    // 2 000 objects moved far away (MOVE of an ARRAY): none of them is drawn here.
    const far = new Map(
      Array.from({ length: 2000 }, (_, i) => [i * 20, translation(50_000, 50_000)] as const),
    );
    expect(count(far)).toBeLessThanOrEqual(still + 50);
  });

  it('the base draws each copy once', () => {
    const cache = new PathCache(scene);
    const ctx = createMockContext();
    drawBase(
      ctx as unknown as CanvasRenderingContext2D,
      modelOf(new Set(), preview),
      cache,
      extents,
      vp,
    );
    expect(ctx.stroke.mock.calls.length).toBeLessThanOrEqual(COUNT + 2000);
  });

  it('object snaps near the copies stay under budget', () => {
    const modes = new Set<SnapMode>(['endpoint', 'midpoint', 'intersection', 'nearest']);
    entityGridOf(scene);
    const source = { scene, preview, isShown: () => true };
    let worst = 0;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      snapsAt(source, { cursor: [100 + i * 37, 100 + i * 23], aperture: 10, modes, anchor: null });
      worst = Math.max(worst, performance.now() - start);
    }
    expect(worst).toBeLessThan(150);
  });
});

describe('wheel zoom burst (audit 10.3)', () => {
  it('the cached picture is carried exactly to the new view', () => {
    const from: ViewTransform = { cx: 100, cy: 50, scale: 2 };
    const to: ViewTransform = { cx: 110, cy: 45, scale: 3 };
    const v = { width: 400, height: 300, dpr: 2 };
    const [r, , , , e, f] = viewShift(from, to, v);
    // A drawing point at device pixel p under `from` lands at r·p + (e, f) under `to`.
    const px = (x: number, y: number, tf: ViewTransform) => ({
      x: ((x - tf.cx) * tf.scale + v.width / 2) * v.dpr,
      y: (v.height / 2 - (y - tf.cy) * tf.scale) * v.dpr,
    });
    for (const [x, y] of [
      [100, 50],
      [37, 81],
      [-20, 3],
    ] as const) {
      const a = px(x, y, from);
      const b = px(x, y, to);
      expect(r * a.x + e).toBeCloseTo(b.x, 6);
      expect(r * a.y + f).toBeCloseTo(b.y, 6);
    }
  });
});
