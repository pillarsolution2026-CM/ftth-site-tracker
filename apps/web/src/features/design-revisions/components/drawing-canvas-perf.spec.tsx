import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { EMPTY_PREVIEW } from '../model/drawing-preview';
import { PathCache, type DrawModel } from '../model/drawing-draw';
import * as draw from '../model/drawing-draw';
import { buildScene } from '../model/drawing-scene';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { perfView } from '../model/perf-scene';
import { zoomAt, type ViewTransform } from '../model/view-transform';
import { DrawingCanvas } from './drawing-canvas';

vi.mock('../model/drawing-draw', async (importOriginal) => {
  const actual = await importOriginal<typeof draw>();
  return { ...actual, drawBase: vi.fn(), drawOverlay: vi.fn() };
});

/**
 * Round 3, audit 10.3 / 10.6 on the canvas itself: a wheel burst on a big drawing scales the
 * cached base instead of redrawing it per wheel step; the pointer moves the crosshair without
 * rendering React.
 */
const scene = buildScene(perfView(5_000));
const size = { width: 800, height: 600 };
let renders = 0;
const cache = new PathCache(scene);
const model: DrawModel = {
  scene,
  preview: EMPTY_PREVIEW,
  layerShown: () => true,
  markers: [],
  highlighted: new Set(),
  selected: null,
};

function Harness() {
  const [transform, setTransform] = useState<ViewTransform>({ cx: 5000, cy: 5000, scale: 0.06 });
  renders++;
  const viewer = {
    transform,
    size,
    setSize: () => undefined,
    cache,
    zoomBy: (sx: number, sy: number, factor: number) =>
      setTransform((tf) => zoomAt(tf, size, sx, sy, factor, { min: 1e-6, max: 1e6 })),
    hoverAt: () => undefined,
    osm: { toLonLat: null },
    edit: {
      pointerStore: { subscribe: () => () => undefined, get: () => null },
      liveDraw: () => ({ ghost: null, sketch: null }),
      boxing: false,
      tracking: false,
      editing: false,
      textEntry: false,
    },
  } as unknown as DrawingViewer;
  return <DrawingCanvas viewer={viewer} model={model} />;
}

describe('the drawing canvas on a big drawing', () => {
  beforeEach(() => {
    vi.stubGlobal('Path2D', FakePath2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      createMockContext() as never,
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.mocked(draw.drawBase).mockClear();
    vi.mocked(draw.drawOverlay).mockClear();
    renders = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a wheel burst draws the base once, then once more when it ends', async () => {
    renderScreen(<Harness />);
    const canvas = screen.getByLabelText(/The drawing: drag to pan/);
    expect(draw.drawBase).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) {
      act(() => {
        fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 300 });
      });
    }
    // Every wheel step is drawn (the overlay), from the scaled cached base.
    expect(vi.mocked(draw.drawOverlay).mock.calls.length).toBeGreaterThanOrEqual(13);
    expect(draw.drawBase).toHaveBeenCalledTimes(1);
    // The burst ends: the exact picture once.
    await waitFor(() => expect(draw.drawBase).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it('moves the crosshair and the coordinates without rendering React', () => {
    renderScreen(<Harness />);
    const canvas = screen.getByLabelText(/The drawing: drag to pan/);
    const before = renders;
    for (let i = 0; i < 20; i++) fireEvent.pointerMove(canvas, { clientX: 100 + i, clientY: 80 });
    expect(renders).toBe(before);
    const hair = screen.getByTestId('crosshair');
    expect(hair.style.display).toBe('');
    expect(hair.style.getPropertyValue('--hx')).toBe('119px');
    expect(screen.getByTestId('drawing-coords')).toHaveTextContent(/X \d+\.\d\d\s+Y \d+\.\d\d/);
    fireEvent.pointerLeave(canvas);
    expect(hair.style.display).toBe('none');
    expect(screen.getByTestId('drawing-coords')).toHaveTextContent('—');
  });
});
