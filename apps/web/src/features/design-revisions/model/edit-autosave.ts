import { DrawingCorrectionInputSchema } from '@ftth/shared';
import { adoptRef, editRef, type CanvasEdit } from './canvas-edit';

/**
 * Autosave of the edits not saved yet (audit 11 / phase 3E, AutoCAD's SAVETIME + Drawing
 * Recovery): every change of the unsaved edits is kept in this browser per drawing file, and
 * entering edit mode again after a closed tab or a crash brings them back (one Undo step). «حفظ»
 * or discarding the edits clears it. Each edit keeps its `ref`, so a later edit naming the item it
 * adds (`NEW-<ref>`, ADR-061) still finds it.
 */

const KEY = 'ftth.cad.unsaved.';
const VERSION = 1;
/** Kept edits above this are not written (the browser's storage is small). */
export const AUTOSAVE_MAX_EDITS = 5000;

interface Stored {
  v: number;
  savedAt: string;
  items: { edit: unknown; ref: string | null }[];
}

export interface Recovered {
  edits: CanvasEdit[];
  savedAt: string;
}

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function saveUnsaved(fileId: string, edits: readonly CanvasEdit[], now = new Date()): void {
  const store = storage();
  if (!store) return;
  try {
    if (edits.length === 0 || edits.length > AUTOSAVE_MAX_EDITS) {
      store.removeItem(KEY + fileId);
      return;
    }
    const value: Stored = {
      v: VERSION,
      savedAt: now.toISOString(),
      items: edits.map((edit) => ({ edit, ref: editRef(edit) })),
    };
    store.setItem(KEY + fileId, JSON.stringify(value));
  } catch {
    // Full or blocked storage: autosave is a convenience, the edits stay on the screen.
  }
}

export function clearUnsaved(fileId: string): void {
  try {
    storage()?.removeItem(KEY + fileId);
  } catch {
    // ignore
  }
}

/** The kept edits of a file, each checked against the contract; null when none (or unreadable). */
export function loadUnsaved(fileId: string): Recovered | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY + fileId);
    if (!raw) return null;
    const value = JSON.parse(raw) as Stored;
    if (value.v !== VERSION || !Array.isArray(value.items)) return null;
    const edits: CanvasEdit[] = [];
    for (const item of value.items) {
      const parsed = DrawingCorrectionInputSchema.safeParse(item.edit);
      if (!parsed.success || parsed.data.kind === 'dismiss_problem') return null;
      const edit = parsed.data as CanvasEdit;
      if (item.ref) adoptRef(edit, item.ref);
      edits.push(edit);
    }
    return edits.length > 0 ? { edits, savedAt: String(value.savedAt) } : null;
  } catch {
    return null;
  }
}
