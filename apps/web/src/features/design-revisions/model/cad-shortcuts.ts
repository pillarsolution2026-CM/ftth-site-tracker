/**
 * AutoCAD's keyboard shortcuts of the edit mode that are not the engine's own (item 24): what a key
 * on the canvas or the command line means. Pure; the workspace runs the action. Undo / Redo
 * (Ctrl+Z / Ctrl+Y), Esc, Enter, Space, Delete live in the edit engine; F3, F7-F12 and Ctrl+0 in
 * the drafting aids (status bar).
 */

export type CadShortcut =
  | 'copyclip'
  | 'cutclip'
  | 'copybase'
  | 'pasteclip'
  | 'selectAll'
  | 'save'
  | 'properties'
  | 'commandLine'
  | 'history'
  /** A key the browser would take (F1 help): kept from it, nothing runs (AutoCAD's help is skipped). */
  | 'none';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutState {
  /** The pen is on (the CAD actions need it; Ctrl+S is still kept from the browser). */
  editing: boolean;
  /** The command line holds a typed text or a selection: the browser keeps copy / paste / all. */
  typing: boolean;
}

/** The action of a key, or null when it is not a shortcut of this set (or not allowed now). */
export function cadShortcut(event: KeyLike, state: ShortcutState): CadShortcut | null {
  const ctrl = event.ctrlKey || event.metaKey;
  if (event.altKey) return null;
  if (!ctrl) {
    if (!state.editing) return null;
    return event.key === 'F2' ? 'history' : event.key === 'F1' ? 'none' : null;
  }
  const k = event.key.toLowerCase();
  // Ctrl+S never saves the web page; it is «حفظ» while editing.
  if (k === 's' && !event.shiftKey) return 'save';
  if (!state.editing) return null;
  if (k === '1' && !event.shiftKey) return 'properties';
  if (k === '9' && !event.shiftKey) return 'commandLine';
  if (state.typing) return null;
  switch (k) {
    case 'c':
      return event.shiftKey ? 'copybase' : 'copyclip';
    case 'x':
      return event.shiftKey ? null : 'cutclip';
    case 'v':
      return event.shiftKey ? null : 'pasteclip';
    case 'a':
      return event.shiftKey ? null : 'selectAll';
    default:
      return null;
  }
}
