import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useHistory, type HistoryPart } from './use-history';

/** A part holding one value, as the edits / the screen do. */
function part(initial: number) {
  const box = { value: initial };
  const p: HistoryPart = {
    capture: () => box.value,
    apply: (state) => {
      box.value = state as number;
    },
  };
  return { box, p };
}

describe('useHistory', () => {
  it('undoes and redoes steps of different parts in one timeline', () => {
    const { result } = renderHook(() => useHistory());
    const edits = part(0);
    const screen = part(10);
    const parts = { edits: edits.p, screen: screen.p };
    act(() => result.current.record('LINE', 'edits', edits.box.value));
    edits.box.value = 1;
    act(() => result.current.record('LAYER', 'screen', screen.box.value));
    screen.box.value = 11;
    expect(result.current.steps).toEqual(['LINE', 'LAYER']);
    let label: string | null = null;
    act(() => {
      label = result.current.undo(parts);
    });
    expect(label).toBe('LAYER');
    expect(screen.box.value).toBe(10);
    act(() => {
      result.current.undo(parts);
    });
    expect(edits.box.value).toBe(0);
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.redo(parts);
    });
    expect(edits.box.value).toBe(1);
    act(() => {
      result.current.redo(parts);
    });
    expect(screen.box.value).toBe(11);
  });

  it('groups the edits of one running command until it is closed', () => {
    const { result } = renderHook(() => useHistory());
    act(() => result.current.record('LINE', 'edits', 0, true));
    act(() => result.current.record('LINE', 'edits', 1, true));
    expect(result.current.steps).toEqual(['LINE']);
    act(() => result.current.close());
    act(() => result.current.record('LINE', 'edits', 2, true));
    expect(result.current.steps).toEqual(['LINE', 'LINE']);
  });

  it('UNDO n takes back n steps at once; Redo brings them back one by one, oldest first', () => {
    const { result } = renderHook(() => useHistory());
    const edits = part(0);
    const screen = part(10);
    const parts = { edits: edits.p, screen: screen.p };
    act(() => result.current.record('LINE', 'edits', 0));
    edits.box.value = 1;
    act(() => result.current.record('LAYER', 'screen', 10));
    screen.box.value = 11;
    act(() => result.current.record('MOVE', 'edits', 1));
    edits.box.value = 2;
    let labels: string[] = [];
    act(() => {
      labels = result.current.undoMany(3, parts);
    });
    expect(labels).toEqual(['MOVE', 'LAYER', 'LINE']);
    expect(edits.box.value).toBe(0);
    expect(screen.box.value).toBe(10);
    expect(result.current.canUndo).toBe(false);
    act(() => {
      result.current.redo(parts);
    });
    expect(edits.box.value).toBe(1);
    act(() => {
      result.current.redo(parts);
    });
    expect(screen.box.value).toBe(11);
    act(() => {
      result.current.redo(parts);
    });
    expect(edits.box.value).toBe(2);
    act(() => {
      labels = result.current.undoMany(5, parts);
    });
    expect(labels).toEqual(['MOVE', 'LAYER', 'LINE']);
  });

  it('a new step empties Redo; clear (save / cancel) empties everything', () => {
    const { result } = renderHook(() => useHistory());
    const edits = part(0);
    act(() => result.current.record('ERASE', 'edits', 0));
    edits.box.value = 1;
    act(() => {
      result.current.undo({ edits: edits.p });
    });
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.record('MOVE', 'edits', 0));
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.clear());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.undo({ edits: edits.p })).toBeNull();
  });
});
