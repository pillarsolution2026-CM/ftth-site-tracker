import { afterEach, describe, expect, it } from 'vitest';
import { copyEdits, editHandle, editRef, rotateEdits, type CanvasEdit } from './canvas-edit';
import { clearUnsaved, loadUnsaved, saveUnsaved } from './edit-autosave';

const FILE = '33333333-3333-4333-8333-333333333333';

afterEach(() => window.localStorage.clear());

describe('autosave of unsaved edits (phase 3E)', () => {
  it('keeps the edits per file and brings them back with their refs', () => {
    const [copy] = copyEdits(['B'], 0, 0) as [CanvasEdit];
    const turn = rotateEdits([editHandle(copy) as string], 1, 2, 90);
    saveUnsaved(FILE, [copy, ...turn], new Date('2026-11-27T10:00:00Z'));
    const back = loadUnsaved(FILE);
    expect(back?.savedAt).toBe('2026-11-27T10:00:00.000Z');
    expect(back?.edits).toEqual([copy, ...turn]);
    // The restored copy keeps its ref: the turn still names it.
    expect(editRef(back?.edits[0] as CanvasEdit)).toBe(editRef(copy));
    expect(loadUnsaved('44444444-4444-4444-8444-444444444444')).toBeNull();
  });

  it('clears on no edits, on clear, and ignores what does not fit the contract', () => {
    saveUnsaved(FILE, [{ kind: 'erase_item', handle: 'B' }]);
    expect(loadUnsaved(FILE)?.edits).toHaveLength(1);
    saveUnsaved(FILE, []);
    expect(loadUnsaved(FILE)).toBeNull();
    saveUnsaved(FILE, [{ kind: 'erase_item', handle: 'B' }]);
    clearUnsaved(FILE);
    expect(loadUnsaved(FILE)).toBeNull();
    window.localStorage.setItem(
      `ftth.cad.unsaved.${FILE}`,
      JSON.stringify({ v: 1, savedAt: 'x', items: [{ edit: { kind: 'nope' }, ref: null }] }),
    );
    expect(loadUnsaved(FILE)).toBeNull();
    window.localStorage.setItem(`ftth.cad.unsaved.${FILE}`, '{broken');
    expect(loadUnsaved(FILE)).toBeNull();
  });
});
