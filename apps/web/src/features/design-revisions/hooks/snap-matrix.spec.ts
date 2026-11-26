import { act, renderHook } from '@testing-library/react';
import type { DrawingViewEntity } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PREVIEW } from '../model/drawing-preview';
import { buildScene } from '../model/drawing-scene';
import { testView } from '../model/drawing-test-view';
import { DEFAULT_DRAFTING } from '../model/drafting';
import { osmodeOf, SNAP_MODES, type Pt, type SnapMode } from '../model/object-snap';
import { DRAFTING_STORAGE_KEY, useDrafting } from './use-drafting';

/**
 * Round 2, item 28 — the matrix: every Object Snap mode, as a running snap and as a one-time
 * override, at a point prompt (it snaps) and off one (it never does: Select objects, options).
 */

const entity = (e: Partial<DrawingViewEntity> & { handle: string }): DrawingViewEntity => ({
  layer: 0,
  color: null,
  kind: 'LINE',
  paths: [],
  texts: [],
  ...e,
});
const circle = (cx: number, cy: number, r: number): number[] => {
  const out: number[] = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
};
const view = testView({
  extents: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  entities: [
    entity({ handle: 'L1', paths: [[0, 0, 10, 0]] }),
    entity({ handle: 'L2', paths: [[5, -5, 5, 5]] }),
    entity({ handle: 'C1', kind: 'CIRCLE', paths: [circle(30, 30, 5)] }),
    entity({ handle: 'N1', kind: 'POINT', paths: [[50, 50]] }),
    entity({
      handle: 'T1',
      kind: 'TEXT',
      texts: [{ x: 60, y: 60, height: 2.5, rotation: 0, text: 'F 36 C' }],
    }),
    entity({ handle: 'P1', kind: 'LWPOLYLINE', paths: [[70, 70, 80, 70, 80, 80, 70, 80, 70, 70]] }),
    entity({ handle: 'L3', paths: [[0, 50, 20, 50]] }),
  ],
});
const scene = buildScene(view);
const source = { scene, preview: EMPTY_PREVIEW, isShown: () => true };

/** Where each mode finds its point: the pointer (a little off it), the point, the last point. */
const CASES: Partial<Record<SnapMode, { cursor: Pt; at: Pt; anchor: Pt | null }>> = {
  endpoint: { cursor: [10.2, 0.2], at: [10, 0], anchor: null },
  midpoint: { cursor: [5.2, 0.1], at: [5, 0], anchor: null },
  center: { cursor: [30.2, 30.2], at: [30, 30], anchor: null },
  geometricCenter: { cursor: [70, 75.2], at: [75, 75], anchor: null },
  node: { cursor: [50.2, 50.2], at: [50, 50], anchor: null },
  quadrant: { cursor: [35.2, 30.2], at: [35, 30], anchor: null },
  intersection: { cursor: [5.2, 0.2], at: [5, 0], anchor: null },
  insertion: { cursor: [60.2, 60.2], at: [60, 60], anchor: null },
  perpendicular: { cursor: [12, 50.2], at: [12, 50], anchor: [12, 70] },
  tangent: { cursor: [30.2, 35.2], at: [30, 35], anchor: [45, 35] },
  nearest: { cursor: [7, 50.2], at: [7, 50], anchor: null },
};

const POINT_PROMPT = { wants: true };

beforeEach(() => window.localStorage.removeItem(DRAFTING_STORAGE_KEY));

describe('Object Snap matrix: point prompts × modes', () => {
  // 10 px per unit: the 10 px aperture is one drawing unit.
  const render = () => renderHook(() => useDrafting({ source, scale: 10, enabled: true }));

  for (const mode of SNAP_MODES) {
    const found = CASES[mode];
    if (!found) continue;
    const { cursor, at, anchor } = found;
    // Tangent from a point to a circle gives two points: the one nearest the pointer.
    const near = (p: readonly number[]) => {
      expect(Math.hypot((p[0] as number) - at[0], (p[1] as number) - at[1])).toBeLessThan(1.1);
    };

    it(`${mode}: a running mode snaps at a point prompt, never at a Select objects / option prompt`, () => {
      const { result } = render();
      act(() => result.current.setModes(new Set([mode])));
      act(() => result.current.toggle('osnap'));
      act(() => result.current.set({ osnap: true, osmode: osmodeOf(new Set([mode])) }));
      let taken: readonly number[] = [];
      act(() => {
        taken = result.current.take(cursor, { ...POINT_PROMPT, anchor });
      });
      if (mode === 'tangent') near(taken);
      else {
        // Computed points (a circle's centre, a foot) are exact to the last digits.
        expect(taken[0]).toBeCloseTo(at[0], 9);
        expect(taken[1]).toBeCloseTo(at[1], 9);
      }
      let raw: readonly number[] = [];
      act(() => {
        raw = result.current.take(cursor, { wants: false, anchor });
      });
      expect(raw).toEqual(cursor);
    });
  }

  it('a one-time override works with the running snap off, and ends after the point', () => {
    const words: [string, SnapMode][] = [
      ['END', 'endpoint'],
      ['MID', 'midpoint'],
      ['CEN', 'center'],
      ['NOD', 'node'],
      ['QUA', 'quadrant'],
      ['INT', 'intersection'],
      ['INS', 'insertion'],
      ['PER', 'perpendicular'],
      ['TAN', 'tangent'],
      ['NEA', 'nearest'],
    ];
    for (const [word, mode] of words) {
      const found = CASES[mode];
      if (!found) continue;
      const { result } = render();
      act(() => result.current.set({ osnap: false }));
      expect(result.current.settings.osnap).toBe(false);
      act(() => {
        expect(result.current.override(word)).toBe(true);
      });
      let taken: readonly number[] = [];
      act(() => {
        taken = result.current.take(found.cursor, { wants: true, anchor: found.anchor });
      });
      expect(
        Math.hypot((taken[0] as number) - found.at[0], (taken[1] as number) - found.at[1]),
      ).toBeLessThan(1.1);
      expect(taken).not.toEqual(found.cursor);
      expect(result.current.overrideMode).toBeNull();
    }
  });

  it('NON turns the running snaps off for one point', () => {
    const { result } = render();
    act(() => result.current.setModes(new Set<SnapMode>(['endpoint'])));
    act(() => {
      result.current.override('non');
    });
    let taken: readonly number[] = [];
    act(() => {
      taken = result.current.take([10.2, 0.2], { wants: true, anchor: null });
    });
    expect(taken).toEqual([10.2, 0.2]);
    act(() => {
      taken = result.current.take([10.2, 0.2], { wants: true, anchor: null });
    });
    expect(taken).toEqual([10, 0]);
  });

  it('FROM and M2P are overrides too', () => {
    const { result } = render();
    act(() => {
      expect(result.current.override('FROM')).toBe(true);
    });
    expect(result.current.special).toEqual({ kind: 'from', base: null });
    act(() => {
      expect(result.current.override('m2p')).toBe(true);
    });
    expect(result.current.special).toEqual({ kind: 'm2p', first: null });
  });

  it('the defaults of AutoCAD are still the running modes', () => {
    expect(DEFAULT_DRAFTING.osnap).toBe(true);
  });
});
