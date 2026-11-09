import { describe, expect, it } from 'vitest';
import {
  clampScale,
  fitTransform,
  panBy,
  scaleLimits,
  toScreen,
  toWorld,
  visibleBounds,
  wheelFactor,
  windowTransform,
  zoomAt,
} from './view-transform';

const size = { width: 800, height: 600 };

describe('view transform', () => {
  it('flips Y: up in the drawing is up on the screen, and round-trips', () => {
    const tf = { cx: 100, cy: 50, scale: 2 };
    expect(toScreen(tf, size, 100, 50)).toEqual({ x: 400, y: 300 });
    expect(toScreen(tf, size, 110, 60)).toEqual({ x: 420, y: 280 });
    const back = toWorld(tf, size, 420, 280);
    expect(back.x).toBeCloseTo(110);
    expect(back.y).toBeCloseTo(60);
  });

  it('fits the extents with a margin, centred, using the tighter axis', () => {
    const tf = fitTransform({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, size, 24);
    expect(tf.cx).toBe(500);
    expect(tf.cy).toBe(50);
    expect(tf.scale).toBeCloseTo((800 - 48) / 1000);
    const corner = toScreen(tf, size, 0, 0);
    expect(corner.x).toBeGreaterThanOrEqual(24 - 1e-9);
  });

  it('fits a drawing of no extent with scale 1', () => {
    expect(fitTransform({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, size).scale).toBe(1);
  });

  it('zooms about the pointer: the point under it stays', () => {
    const tf = { cx: 0, cy: 0, scale: 1 };
    const limits = { min: 0.01, max: 1000 };
    const before = toWorld(tf, size, 600, 100);
    const zoomed = zoomAt(tf, size, 600, 100, 4, limits);
    expect(zoomed.scale).toBe(4);
    const after = toWorld(zoomed, size, 600, 100);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps the scale to the limits', () => {
    const limits = scaleLimits({ cx: 0, cy: 0, scale: 2 });
    expect(clampScale(1e-9, limits)).toBe(limits.min);
    expect(clampScale(1e12, limits)).toBe(limits.max);
    expect(zoomAt({ cx: 0, cy: 0, scale: 2 }, size, 0, 0, 1e9, limits).scale).toBe(limits.max);
  });

  it('pans so the content follows the pointer', () => {
    const tf = { cx: 0, cy: 0, scale: 2 };
    const moved = panBy(tf, 20, 10);
    // A drawing point that was at the centre is now 20 px right and 10 px down.
    expect(toScreen(moved, size, 0, 0)).toEqual({ x: 420, y: 310 });
  });

  it('shows a square window around a place', () => {
    const tf = windowTransform(10, 20, 30, size);
    expect(tf.scale).toBe(600 / 60);
    const b = visibleBounds(tf, size);
    expect(b.minY).toBeCloseTo(-10);
    expect(b.maxY).toBeCloseTo(50);
  });

  it('wheel up zooms in, wheel down zooms out', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
  });
});
