import { describe, expect, it } from 'vitest';
import { cadShortcut, type KeyLike } from './cad-shortcuts';
import { PANEL_ORDER } from '../components/cad-ribbon';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const editing = { editing: true, typing: false };

describe('AutoCAD shortcuts of the edit mode', () => {
  it('maps the clipboard keys', () => {
    expect(cadShortcut(key('c', { ctrlKey: true }), editing)).toBe('copyclip');
    expect(cadShortcut(key('C', { ctrlKey: true, shiftKey: true }), editing)).toBe('copybase');
    expect(cadShortcut(key('x', { ctrlKey: true }), editing)).toBe('cutclip');
    expect(cadShortcut(key('v', { ctrlKey: true }), editing)).toBe('pasteclip');
    expect(cadShortcut(key('v', { metaKey: true }), editing)).toBe('pasteclip');
  });

  it('maps Ctrl+A, S, 1, 9 and F2', () => {
    expect(cadShortcut(key('a', { ctrlKey: true }), editing)).toBe('selectAll');
    expect(cadShortcut(key('s', { ctrlKey: true }), editing)).toBe('save');
    expect(cadShortcut(key('1', { ctrlKey: true }), editing)).toBe('properties');
    expect(cadShortcut(key('9', { ctrlKey: true }), editing)).toBe('commandLine');
    expect(cadShortcut(key('F2'), editing)).toBe('history');
    expect(cadShortcut(key('F1'), editing)).toBe('none');
  });

  it('leaves the keys the engine and the status bar own (Z, Y, F3, F7-F12, 0, Delete, Esc)', () => {
    for (const k of ['z', 'y', '0'])
      expect(cadShortcut(key(k, { ctrlKey: true }), editing)).toBeNull();
    for (const k of ['F3', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Delete', 'Escape', 'Enter', ' '])
      expect(cadShortcut(key(k), editing)).toBeNull();
  });

  it('keeps the browser page save away even when not editing, and nothing else then', () => {
    const idle = { editing: false, typing: false };
    expect(cadShortcut(key('s', { ctrlKey: true }), idle)).toBe('save');
    expect(cadShortcut(key('c', { ctrlKey: true }), idle)).toBeNull();
    expect(cadShortcut(key('F2'), idle)).toBeNull();
  });

  it('leaves copy / paste / select-all to a command line that holds a text', () => {
    const typing = { editing: true, typing: true };
    for (const k of ['c', 'x', 'v', 'a'])
      expect(cadShortcut(key(k, { ctrlKey: true }), typing)).toBeNull();
    expect(cadShortcut(key('s', { ctrlKey: true }), typing)).toBe('save');
  });

  it('ignores Alt chords', () => {
    expect(cadShortcut(key('c', { ctrlKey: true, altKey: true }), editing)).toBeNull();
  });
});

describe('ribbon panels', () => {
  it('counts every panel in the one-row fit (the Text panel too, so none is cut at the edge)', () => {
    expect(PANEL_ORDER).toEqual([
      'draw',
      'modify',
      'annotation',
      'text',
      'layers',
      'groups',
      'block',
      'properties',
      // Round 3 (audit 8): AutoCAD's Home tab ends with Utilities and Clipboard.
      'utilities',
      'clipboard',
    ]);
  });
});
