import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PREVIEW } from '../model/drawing-preview';
import { buildScene } from '../model/drawing-scene';
import { testView } from '../model/drawing-test-view';
import { ACQUIRE_MS, DRAFTING_STORAGE_KEY, useDrafting } from './use-drafting';

const scene = buildScene(testView());
const source = { scene, preview: EMPTY_PREVIEW, isShown: () => true };
// 10 px per unit: the 10 px aperture is one drawing unit.
const render = () => renderHook(() => useDrafting({ source, scale: 10, enabled: true }));
const wants = { wants: true, anchor: null };

beforeEach(() => window.localStorage.removeItem(DRAFTING_STORAGE_KEY));
afterEach(() => vi.useRealTimers());

describe('useDrafting', () => {
  it('a point near an endpoint is taken on it; off a point prompt nothing snaps', () => {
    const { result } = render();
    expect(result.current.take([99.6, 25.3], wants)).toEqual([100, 25]);
    expect(result.current.take([99.6, 25.3], { wants: false, anchor: null })).toEqual([99.6, 25.3]);
  });

  it('a typed MID is a one-time override, gone after the point', () => {
    const { result } = render();
    act(() => {
      expect(result.current.override('mid')).toBe(true);
    });
    expect(result.current.overrideMode).toBe('midpoint');
    let at: readonly number[] = [];
    act(() => {
      at = result.current.take([75.2, 25.3], wants);
    });
    expect(at).toEqual([75, 25]);
    expect(result.current.overrideMode).toBeNull();
    expect(result.current.override('line')).toBe(false);
  });

  it('Tab steps through the snaps in the aperture', () => {
    const { result } = render();
    act(() => result.current.setMode('midpoint', true));
    act(() => result.current.setMode('nearest', true));
    act(() => {
      result.current.move([99.6, 25.2], wants);
    });
    const firstHit = result.current.store.get().resolved?.snap?.mode;
    act(() => {
      expect(result.current.key('Tab', false)).toBe(true);
    });
    expect(result.current.store.get().resolved?.snap?.mode).not.toBe(firstHit);
  });

  it('resting on a snap point acquires it for tracking', () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => {
      result.current.move([99.8, 25.1], wants);
    });
    expect(result.current.store.get().acquired).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(ACQUIRE_MS + 10);
    });
    expect(result.current.store.get().acquired[0]?.at).toEqual([100, 25]);
    // Tracking: straight up from the acquired endpoint, far from anything else.
    let p: readonly number[] = [];
    act(() => {
      p = result.current.move([100.3, 45], wants);
    });
    expect(p[0]).toBeCloseTo(100);
  });

  it('F-keys toggle the aids', () => {
    const { result } = render();
    act(() => {
      result.current.key('F8', false);
    });
    expect(result.current.settings).toMatchObject({ ortho: true, polar: false });
    act(() => {
      result.current.key('F12', false);
    });
    expect(result.current.settings.dyn).toBe(false);
  });
});
