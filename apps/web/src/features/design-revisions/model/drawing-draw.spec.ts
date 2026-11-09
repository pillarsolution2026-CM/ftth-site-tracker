import type { DrawingProblemView } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drawBase, drawOverlay, PathCache, type DrawModel } from './drawing-draw';
import { buildMarkers } from './drawing-hit';
import { applyCorrections, EMPTY_PREVIEW } from './drawing-preview';
import { buildScene } from './drawing-scene';
import { testView } from './drawing-test-view';
import { createMockContext, FakePath2D } from './mock-canvas';

beforeEach(() => {
  vi.stubGlobal('Path2D', FakePath2D);
});

const scene = buildScene(testView());
const vp = { width: 800, height: 600, dpr: 1 };
const asCtx = (ctx: ReturnType<typeof createMockContext>) =>
  ctx as unknown as CanvasRenderingContext2D;

function model(overrides: Partial<DrawModel> = {}): DrawModel {
  return {
    scene,
    preview: EMPTY_PREVIEW,
    layerShown: (index) => scene.view.layers[index]?.visible ?? true,
    markers: [],
    highlighted: new Set(),
    selected: null,
    ...overrides,
  };
}

describe('drawBase', () => {
  it('clears to white and strokes shown entities with a hairline of 1 px at any zoom', () => {
    for (const scale of [2, 8]) {
      const ctx = createMockContext();
      drawBase(asCtx(ctx), model(), new PathCache(scene), { cx: 50, cy: 25, scale }, vp);
      expect(ctx.fillRect).toHaveBeenCalled();
      expect(ctx.lineWidth).toBeCloseTo(1 / scale);
    }
  });

  it('draws the world flipped (negative Y scale) so Y points up', () => {
    const ctx = createMockContext();
    drawBase(asCtx(ctx), model(), new PathCache(scene), { cx: 50, cy: 25, scale: 4 }, vp);
    const worldCall = ctx.setTransform.mock.calls.find((call) => (call[3] as number) < 0);
    expect(worldCall?.[0]).toBe(4);
    expect(worldCall?.[3]).toBe(-4);
  });

  it('skips off-screen entities and entities on hidden layers', () => {
    const ctx = createMockContext();
    // Only the second route (x 50..100, y 25) is in the window; the hidden-layer line is off.
    drawBase(asCtx(ctx), model(), new PathCache(scene), { cx: 90, cy: 25, scale: 20 }, vp);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    const all = createMockContext();
    drawBase(asCtx(all), model(), new PathCache(scene), { cx: 50, cy: 25, scale: 4 }, vp);
    // A, B and A1 are strokes; H1 is on the hidden layer.
    expect(all.stroke).toHaveBeenCalledTimes(3);
    const shownAll = createMockContext();
    drawBase(
      asCtx(shownAll),
      model({ layerShown: () => true }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    expect(shownAll.stroke).toHaveBeenCalledTimes(4);
  });

  it('follows a moved entity to its target layer for visibility and colour', () => {
    const preview = applyCorrections(
      scene,
      [
        {
          id: '44444444-4444-4444-8444-444444444444',
          cadFileId: scene.view.cadFileId,
          correction: { kind: 'move_layer', handle: 'A1', toLayer: 'Hidden' },
          problem: null,
          createdBy: null,
          createdAt: '2026-11-09T10:00:00+00:00',
          withdrawnBy: null,
          withdrawnAt: null,
        },
      ],
      2.5,
    );
    const ctx = createMockContext();
    drawBase(
      asCtx(ctx),
      model({ preview }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    // A1 now sits on the hidden layer: A and B only.
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
  });

  it('draws texts scaled to their height and rotation, and hides those under 3 px', () => {
    const big = createMockContext();
    drawBase(asCtx(big), model(), new PathCache(scene), { cx: 30, cy: 30, scale: 10 }, vp);
    expect(big.fillText).toHaveBeenCalledWith('F 36 C', 0, 0);
    expect(big.translate).toHaveBeenCalledWith(400, 300);
    const small = createMockContext();
    // 2.5 units × 1 px/unit = 2.5 px: hidden.
    drawBase(asCtx(small), model(), new PathCache(scene), { cx: 30, cy: 30, scale: 1 }, vp);
    expect(small.fillText).not.toHaveBeenCalled();
  });

  it('replaces a text with the corrected one and draws added texts', () => {
    const preview = applyCorrections(
      scene,
      [
        {
          id: '44444444-4444-4444-8444-444444444444',
          cadFileId: scene.view.cadFileId,
          correction: { kind: 'set_text', handle: 'T1', text: 'F 36 C 90 m' },
          problem: null,
          createdBy: null,
          createdAt: '2026-11-09T10:00:00+00:00',
          withdrawnBy: null,
          withdrawnAt: null,
        },
        {
          id: '55555555-5555-4555-8555-555555555555',
          cadFileId: scene.view.cadFileId,
          correction: { kind: 'add_text', layer: 'Sap', x: 30, y: 28, text: 'NEW', height: null },
          problem: null,
          createdBy: null,
          createdAt: '2026-11-09T10:01:00+00:00',
          withdrawnBy: null,
          withdrawnAt: null,
        },
      ],
      2.5,
    );
    const ctx = createMockContext();
    drawBase(
      asCtx(ctx),
      model({ preview }),
      new PathCache(scene),
      { cx: 30, cy: 30, scale: 10 },
      vp,
    );
    const texts = ctx.fillText.mock.calls.map((call) => call[0]);
    expect(texts).toContain('F 36 C 90 m');
    expect(texts).toContain('NEW');
    expect(texts).not.toContain('F 36 C');
  });

  it('builds each Path2D once, relative to the origin', () => {
    const cache = new PathCache(scene);
    expect(cache.get(0)).toBe(cache.get(0));
    expect((cache.get(0) as unknown as FakePath2D).segments).toBe(3);
  });
});

describe('drawOverlay', () => {
  const problems = [
    {
      code: 'WRONG_LAYER',
      severity: 'warning',
      count: 2,
      items: [
        { handle: 'A1', drawingX: 21, drawingY: 21, layer: 'Sap', x: 0, y: 0 },
        { handle: 'B', drawingX: 75, drawingY: 25, layer: 'Route', x: 0, y: 0 },
      ],
    },
  ] as unknown as DrawingProblemView[];

  it('draws a red ring with the code for an error and a green check for a fixed place', () => {
    const markers = buildMarkers(problems, new Set(['WRONG_LAYER:B']));
    const ctx = createMockContext();
    drawOverlay(
      asCtx(ctx),
      model({ markers }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    expect(ctx.fillText).toHaveBeenCalledWith(
      'WRONG_LAYER',
      expect.any(Number),
      expect.any(Number),
    );
    // The fixed place draws a check mark (two line segments) after its filled circle.
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('keeps markers a fixed size on screen at any zoom', () => {
    const markers = buildMarkers(problems, new Set());
    const radii = [1, 40].map((scale) => {
      const ctx = createMockContext();
      drawOverlay(
        asCtx(ctx),
        model({ markers }),
        new PathCache(scene),
        { cx: 21, cy: 21, scale },
        vp,
      );
      return ctx.arc.mock.calls[0]?.[2];
    });
    expect(radii[0]).toBe(radii[1]);
  });

  it('draws a halo and a dashed box for a highlighted entity, only when it is shown', () => {
    const ctx = createMockContext();
    drawOverlay(
      asCtx(ctx),
      model({ highlighted: new Set([0]) }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
    const hidden = createMockContext();
    drawOverlay(
      asCtx(hidden),
      model({ highlighted: new Set([4]) }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    expect(hidden.strokeRect).not.toHaveBeenCalled();
  });

  it('draws added items as a circle with a cross', () => {
    const preview = applyCorrections(
      scene,
      [
        {
          id: '44444444-4444-4444-8444-444444444444',
          cadFileId: scene.view.cadFileId,
          correction: { kind: 'add_item', layer: 'CABINET', x: 10, y: 10 },
          problem: null,
          createdBy: null,
          createdAt: '2026-11-09T10:00:00+00:00',
          withdrawnBy: null,
          withdrawnAt: null,
        },
      ],
      2.5,
    );
    const ctx = createMockContext();
    drawOverlay(
      asCtx(ctx),
      model({ preview }),
      new PathCache(scene),
      { cx: 50, cy: 25, scale: 4 },
      vp,
    );
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.strokeStyle).toBe('#0000ff');
  });
});
