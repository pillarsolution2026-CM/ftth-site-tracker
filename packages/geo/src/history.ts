/**
 * Unlimited undo/redo for one editing session («تراجع غير محدود في الجلسة»).
 * Immutable: every operation returns a new history. Only the final state of a
 * session becomes an As-Built event; intermediate steps never leave the device.
 */
export interface EditHistory<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function startHistory<T>(initial: T): EditHistory<T> {
  return { past: [], present: initial, future: [] };
}

/** Records a new state; any redo branch is discarded. */
export function record<T>(history: EditHistory<T>, next: T): EditHistory<T> {
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function canUndo<T>(history: EditHistory<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: EditHistory<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: EditHistory<T>): EditHistory<T> {
  if (!canUndo(history)) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1] as T,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: EditHistory<T>): EditHistory<T> {
  if (!canRedo(history)) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0] as T,
    future: history.future.slice(1),
  };
}
