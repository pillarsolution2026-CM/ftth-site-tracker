'use client';

import { useState } from 'react';

/**
 * AutoCAD's UNDO / REDO for everything done on the drawing (owner 2026-11-26, item 13): one
 * timeline of steps, each an edit (a whole command, as AutoCAD's U) or a screen state (layers
 * on / off / freeze / lock / colour, isolate / hide, layer states, locked fading). A step keeps
 * the state from before it; Undo puts that back and keeps the state it replaced for Redo. Zoom
 * and pan are not steps; «حفظ» and «إلغاء» empty the history (Undo stops at the last save).
 */

/** Something the history can read and put back (the edits, the screen). */
export interface HistoryPart {
  capture: () => unknown;
  apply: (state: unknown) => void;
}

export interface HistoryStep {
  /** AutoCAD's name of what is undone (LINE, ERASE, LAYER…), echoed on the command line. */
  label: string;
  part: string;
  before: unknown;
}

export interface UndoHistory {
  /**
   * A step is about to change `part`; `before` is its state now. With `group`, a step of the same
   * command joins the open one (a LINE of several segments is one Undo).
   */
  record: (label: string, part: string, before: unknown, group?: boolean) => void;
  /** The command ended: its group is closed. */
  close: () => void;
  /** Undoes the last step; its label, or null when there is none. */
  undo: (parts: Readonly<Record<string, HistoryPart>>) => string | null;
  redo: (parts: Readonly<Record<string, HistoryPart>>) => string | null;
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** The labels of the steps, oldest first (for tests and the list). */
  steps: readonly string[];
}

/** AutoCAD keeps as many as memory allows; the page keeps this many. */
export const MAX_STEPS = 200;

interface State {
  done: readonly HistoryStep[];
  undone: readonly HistoryStep[];
  /** The last step is a command still running (more of its edits join it). */
  open: boolean;
}

const EMPTY: State = { done: [], undone: [], open: false };

export function useHistory(): UndoHistory {
  const [state, setState] = useState<State>(EMPTY);
  const swap = (
    from: 'done' | 'undone',
    parts: Readonly<Record<string, HistoryPart>>,
  ): string | null => {
    const list = state[from];
    const step = list[list.length - 1];
    const part = step ? parts[step.part] : undefined;
    if (!step || !part) return null;
    const back: HistoryStep = { ...step, before: part.capture() };
    part.apply(step.before);
    setState((s) => {
      const to = from === 'done' ? 'undone' : 'done';
      return { ...s, open: false, [from]: s[from].slice(0, -1), [to]: [...s[to], back] };
    });
    return step.label;
  };
  return {
    record: (label, part, before, group = false) =>
      setState((s) => {
        const last = s.done[s.done.length - 1];
        if (group && s.open && last && last.part === part && last.label === label) {
          return { ...s, undone: [] };
        }
        return {
          done: [...s.done, { label, part, before }].slice(-MAX_STEPS),
          undone: [],
          open: group,
        };
      }),
    close: () => setState((s) => (s.open ? { ...s, open: false } : s)),
    undo: (parts) => swap('done', parts),
    redo: (parts) => swap('undone', parts),
    clear: () => setState(EMPTY),
    canUndo: state.done.length > 0,
    canRedo: state.undone.length > 0,
    steps: state.done.map((s) => s.label),
  };
}
