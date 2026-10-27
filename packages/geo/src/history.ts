import { applyEdit, type EditOperation } from './edits.js';
import type { Polyline } from './point.js';

/**
 * Unlimited undo/redo of edit operations for one session («تراجع غير محدود في الجلسة»).
 * Each applied step keeps the route it started from, so undo restores it exactly
 * (no float drift from inverse operations). Immutable: every call returns a new session.
 */
export interface EditSession {
  readonly base: Polyline;
  readonly present: Polyline;
  readonly done: readonly { readonly op: EditOperation; readonly before: Polyline }[];
  readonly undone: readonly EditOperation[];
}

export function startEditSession(base: Polyline): EditSession {
  return { base, present: base, done: [], undone: [] };
}

/** Applies a new operation; any redo branch is discarded. Throws (session unchanged) if the operation is invalid. */
export function applyToSession(session: EditSession, op: EditOperation): EditSession {
  return {
    base: session.base,
    present: applyEdit(session.present, op),
    done: [...session.done, { op, before: session.present }],
    undone: [],
  };
}

export function canUndo(session: EditSession): boolean {
  return session.done.length > 0;
}

export function canRedo(session: EditSession): boolean {
  return session.undone.length > 0;
}

export function undoEdit(session: EditSession): EditSession {
  const last = session.done[session.done.length - 1];
  if (last === undefined) return session;
  return {
    base: session.base,
    present: last.before,
    done: session.done.slice(0, -1),
    undone: [last.op, ...session.undone],
  };
}

export function redoEdit(session: EditSession): EditSession {
  const [next, ...rest] = session.undone;
  if (next === undefined) return session;
  return { ...applyToSession(session, next), undone: rest };
}

/** Operations currently in effect, in order: replaying them on `base` gives `present`. */
export function appliedOperations(session: EditSession): EditOperation[] {
  return session.done.map((step) => step.op);
}
