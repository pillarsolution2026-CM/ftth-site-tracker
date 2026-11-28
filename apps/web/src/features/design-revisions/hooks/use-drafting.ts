'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { matchOption, parseEntry, type Point } from '../model/cad-commands';
import {
  activeModes,
  DEFAULT_DRAFTING,
  parseDrafting,
  resolvePoint,
  toggleOrtho,
  togglePolar,
  type DraftingSettings,
  type Resolved,
} from '../model/drafting';
import {
  dist,
  endDirection,
  modesOf,
  OSMODE_BIT,
  osmodeOf,
  overrideOf,
  segmentDirection,
  shapesNear,
  snapsAt,
  specialOverrideOf,
  type Acquired,
  type Pt,
  type SnapHit,
  type SnapMode,
  type SnapSource,
  type SpecialOverride,
} from '../model/object-snap';
import { latinize } from '../model/keyboard-layout';
import type { CanvasEditState } from './use-canvas-edit';

/**
 * The status bar's drafting aids (owner 2026-11-26, item 14): the toggles and their F-keys, the
 * object snap search on every pointer move, AutoSnap's acquired points for tracking, and the
 * point each command takes. The pointer state lives in a small store, so a move redraws only the
 * markers and the coordinates, not the whole viewer.
 */

export const DRAFTING_STORAGE_KEY = 'ftth.drafting';
/** AutoCAD acquires a point for tracking when the pointer rests on it this long. */
export const ACQUIRE_MS = 500;
/** AutoCAD keeps at most seven acquired points. */
const MAX_ACQUIRED = 7;

export interface PointerState {
  /** The pointer in drawing units; null off the canvas. */
  cursor: Pt | null;
  /** A command waits for a point (snaps are looked for and drawn). */
  wants: boolean;
  anchor: Pt | null;
  resolved: Resolved | null;
  /** Every snap in the aperture (Tab steps through them). */
  snaps: readonly SnapHit[];
  acquired: readonly Acquired[];
}

const EMPTY_POINTER: PointerState = {
  cursor: null,
  wants: false,
  anchor: null,
  resolved: null,
  snaps: [],
  acquired: [],
};

export interface PointerStore {
  get: () => PointerState;
  set: (next: PointerState) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPointerStore(): PointerStore {
  let state = EMPTY_POINTER;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePointer(store: PointerStore): PointerState {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY_POINTER);
}

/** Where the point prompts stand, from the edit mode. */
export interface PointContext {
  wants: boolean;
  anchor: Pt | null;
}

/** FROM (base, then offset) and Mid Between 2 Points (two points) wait for their points. */
export type SpecialPoint = { kind: 'from'; base: Pt | null } | { kind: 'm2p'; first: Pt | null };

export type DraftingToggle =
  | 'grid'
  | 'snap'
  | 'ortho'
  | 'polar'
  | 'osnap'
  | 'otrack'
  | 'dyn'
  | 'lineweight'
  | 'transparency'
  | 'selectionCycling'
  | 'quickProperties';

export type DraftingTab = 'snap' | 'polar' | 'osnap' | 'dyn';

/** Two or more objects under a pick with Selection Cycling on: the list to choose from. */
export interface CycleChoice {
  at: Point;
  candidates: readonly number[];
  /** The row under the pointer: that object is lit on the drawing (AutoCAD). */
  lit?: number | null;
  /** Picks the one chosen (as the click would have). */
  choose: (index: number) => void;
}

export interface Drafting {
  settings: DraftingSettings;
  set: (patch: Partial<DraftingSettings>) => void;
  toggle: (which: DraftingToggle) => void;
  modes: ReadonlySet<SnapMode>;
  setMode: (mode: SnapMode, on: boolean) => void;
  setModes: (modes: ReadonlySet<SnapMode>) => void;
  store: PointerStore;
  /** The pointer moved: the point a command would take there. */
  move: (cursor: Pt, ctx: PointContext) => Pt;
  /** A click: the point the command takes (acquired points and a one-time override end). */
  take: (cursor: Pt, ctx: PointContext) => Pt;
  /** F3, F7, F8, F9, F10, F11, F12, Ctrl+0 and Tab; true when used. */
  key: (key: string, ctrl: boolean, shift?: boolean) => boolean;
  /** A word typed at a point prompt: END, MID, … (one-time override); true when it was one. */
  override: (word: string) => boolean;
  overrideMode: SnapMode | 'none' | null;
  /** FROM / M2P in progress (the point prompt asks for their points first); null otherwise. */
  special: SpecialPoint | null;
  setSpecial: (special: SpecialPoint | null) => void;
  /** The Drafting Settings dialog (the tab it opens on); null when closed. */
  dialog: DraftingTab | null;
  openDialog: (tab: DraftingTab | null) => void;
  /** Clean Screen (Ctrl+0): the ribbon and palettes give their room to the drawing. */
  cleanScreen: boolean;
  setCleanScreen: (on: boolean) => void;
  cycle: CycleChoice | null;
  setCycle: (choice: CycleChoice | null) => void;
}

interface Input {
  /** The drawing to snap to; null before it is loaded. */
  source: SnapSource | null;
  /** Pixels per drawing unit now (the aperture is in pixels). */
  scale: number;
  /** F-keys are listened to on the page. */
  enabled: boolean;
}

function readSettings(): DraftingSettings {
  try {
    const raw = window.localStorage.getItem(DRAFTING_STORAGE_KEY);
    return raw ? parseDrafting(JSON.parse(raw)) : DEFAULT_DRAFTING;
  } catch {
    return DEFAULT_DRAFTING;
  }
}

const sameHit = (a: SnapHit | null | undefined, b: SnapHit | null | undefined) =>
  !!a && !!b && a.mode === b.mode && dist(a.at, b.at) < 1e-9;

export function useDrafting(input: Input): Drafting {
  const { source, scale } = input;
  const [settings, setSettings] = useState<DraftingSettings>(DEFAULT_DRAFTING);
  const [loaded, setLoaded] = useState(false);
  const [store] = useState(createPointerStore);
  const [overrideMode, setOverrideMode] = useState<SnapMode | 'none' | null>(null);
  const [special, setSpecial] = useState<SpecialPoint | null>(null);
  const [dialog, setDialog] = useState<DraftingTab | null>(null);
  const [cleanScreen, setCleanScreen] = useState(false);
  const [cycle, setCycle] = useState<CycleChoice | null>(null);
  const cycleIndex = useRef(0);
  const acquireTimer = useRef<number | null>(null);
  const pendingHit = useRef<SnapHit | null>(null);
  const parallels = useRef<Pt[]>([]);

  // The settings live in this browser, as AutoCAD keeps them between sessions.
  useEffect(() => {
    setSettings(readSettings());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(DRAFTING_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // No storage (private window): the settings last for this visit.
    }
  }, [settings, loaded]);
  useEffect(
    () => () => {
      if (acquireTimer.current !== null) window.clearTimeout(acquireTimer.current);
    },
    [],
  );

  const aperture = settings.aperture / (scale > 0 ? scale : 1);
  const runningModes = activeModes(settings);
  const modesNow = (): ReadonlySet<SnapMode> =>
    overrideMode === 'none'
      ? new Set()
      : overrideMode !== null
        ? new Set([overrideMode])
        : runningModes;

  const compute = (cursor: Pt, ctx: PointContext, acquired: readonly Acquired[]): PointerState => {
    if (!ctx.wants || !source) {
      return { cursor, wants: false, anchor: null, resolved: null, snaps: [], acquired };
    }
    const modes = modesNow();
    const snaps =
      modes.size > 0
        ? snapsAt(source, {
            cursor,
            aperture,
            modes,
            anchor: ctx.anchor,
            acquired,
            parallels: parallels.current,
          })
        : [];
    const resolved = resolvePoint({
      cursor,
      anchor: ctx.anchor,
      settings: overrideMode !== null ? { ...settings, osnap: overrideMode !== 'none' } : settings,
      snaps,
      cycle: cycleIndex.current,
      acquired: settings.otrack ? acquired : [],
      aperture,
    });
    return { cursor, wants: true, anchor: ctx.anchor, resolved, snaps, acquired };
  };

  /** AutoSnap: resting on a snap point acquires it (again: lets it go), as AutoCAD. */
  const scheduleAcquire = (hit: SnapHit | null, cursor: Pt, ctx: PointContext) => {
    const tracksPoints = settings.otrack || runningModes.has('extension');
    const wantsParallel = runningModes.has('parallel') && ctx.anchor !== null;
    if (sameHit(hit, pendingHit.current)) return;
    if (acquireTimer.current !== null) window.clearTimeout(acquireTimer.current);
    acquireTimer.current = null;
    pendingHit.current = hit;
    if (!source || (!tracksPoints && !wantsParallel)) return;
    if (!hit && !wantsParallel) return;
    acquireTimer.current = window.setTimeout(() => {
      acquireTimer.current = null;
      const now = store.get();
      if (hit && tracksPoints && (hit.mode !== 'nearest' || settings.otrack)) {
        const near = shapesNear(source, {
          minX: hit.at[0] - aperture,
          minY: hit.at[1] - aperture,
          maxX: hit.at[0] + aperture,
          maxY: hit.at[1] + aperture,
        });
        const had = now.acquired.some((a) => dist(a.at, hit.at) < 1e-9);
        const acquired = had
          ? now.acquired.filter((a) => dist(a.at, hit.at) >= 1e-9)
          : [
              ...now.acquired,
              { at: hit.at, dir: hit.mode === 'endpoint' ? endDirection(near, hit.at) : null },
            ].slice(-MAX_ACQUIRED);
        store.set(compute(cursor, ctx, acquired));
      } else if (wantsParallel) {
        const near = shapesNear(source, {
          minX: cursor[0] - aperture,
          minY: cursor[1] - aperture,
          maxX: cursor[0] + aperture,
          maxY: cursor[1] + aperture,
        });
        const dir = segmentDirection(near, cursor, aperture);
        if (dir) {
          parallels.current = [dir];
          store.set(compute(cursor, ctx, now.acquired));
        }
      }
    }, ACQUIRE_MS);
  };

  const move = (cursor: Pt, ctx: PointContext): Pt => {
    const before = store.get();
    if (!ctx.wants) parallels.current = [];
    const acquired = ctx.wants ? before.acquired : [];
    const next = compute(cursor, ctx, acquired);
    if (next.snaps.length !== before.snaps.length) cycleIndex.current = 0;
    store.set(next);
    if (ctx.wants) scheduleAcquire(next.resolved?.snap ?? null, cursor, ctx);
    return next.resolved?.at ?? cursor;
  };

  const take = (cursor: Pt, ctx: PointContext): Pt => {
    if (!ctx.wants) return cursor;
    const at = compute(cursor, ctx, store.get().acquired).resolved?.at ?? cursor;
    // A point taken: the one-time override and the acquired points end.
    setOverrideMode(null);
    parallels.current = [];
    cycleIndex.current = 0;
    pendingHit.current = null;
    if (acquireTimer.current !== null) window.clearTimeout(acquireTimer.current);
    acquireTimer.current = null;
    store.set({ ...store.get(), acquired: [], snaps: [], resolved: null });
    return at;
  };

  const toggle = (which: DraftingToggle) =>
    setSettings((s) => {
      if (which === 'ortho') return toggleOrtho(s);
      if (which === 'polar') return togglePolar(s);
      return { ...s, [which]: !s[which] };
    });

  const key = (k: string, ctrl: boolean, shift = false): boolean => {
    if (ctrl && k === '0') {
      setCleanScreen((on) => !on);
      return true;
    }
    if (ctrl) return false;
    switch (k) {
      case 'F3':
        toggle('osnap');
        return true;
      case 'F7':
        toggle('grid');
        return true;
      case 'F8':
        toggle('ortho');
        return true;
      case 'F9':
        toggle('snap');
        return true;
      case 'F10':
        toggle('polar');
        return true;
      case 'F11':
        toggle('otrack');
        return true;
      case 'F12':
        toggle('dyn');
        return true;
      case 'Tab': {
        // Tab steps through the snaps in the aperture (AutoCAD), Shift+Tab back.
        const now = store.get();
        if (!now.wants || now.snaps.length < 2 || !now.cursor) return false;
        const n = now.snaps.length;
        cycleIndex.current = (cycleIndex.current + (shift ? n - 1 : 1)) % n;
        store.set(compute(now.cursor, { wants: true, anchor: now.anchor }, now.acquired));
        return true;
      }
      default:
        return false;
    }
  };

  // F-keys work wherever the focus is on the page, as in AutoCAD (not in a text box being typed).
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  });
  const { enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key === 'Tab') return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (!/^F(3|7|8|9|10|11|12)$/.test(event.key) && !(ctrl && event.key === '0')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('textarea, select, [contenteditable="true"]')) return;
      if (keyRef.current(event.key, ctrl, event.shiftKey)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  return {
    settings,
    set: (patch) => setSettings((s) => parseDrafting({ ...s, ...patch })),
    toggle,
    modes: modesOf(settings.osmode),
    setMode: (mode, on) =>
      setSettings((s) => ({
        ...s,
        osmode: on ? s.osmode | OSMODE_BIT[mode] : s.osmode & ~OSMODE_BIT[mode],
        // Choosing a mode in the drop-down turns object snap on (AutoCAD).
        osnap: on ? true : s.osnap,
      })),
    setModes: (modes) => setSettings((s) => ({ ...s, osmode: osmodeOf(modes) })),
    store,
    move,
    take,
    key,
    override: (word) => {
      const kind: SpecialOverride | null = specialOverrideOf(word);
      if (kind !== null) {
        setOverrideMode(null);
        setSpecial(kind === 'from' ? { kind: 'from', base: null } : { kind: 'm2p', first: null });
        return true;
      }
      const mode = overrideOf(word);
      if (mode === null) return false;
      setOverrideMode(mode);
      return true;
    },
    overrideMode,
    special,
    setSpecial,
    dialog,
    openDialog: setDialog,
    cleanScreen,
    setCleanScreen,
    cycle,
    setCycle,
  };
}

const pt = (p: Point): Pt => [p.x, p.y];
const xy = (p: Pt): Point => ({ x: p[0], y: p[1] });

/**
 * The edit mode with the status bar's aids in front of it: every point a command takes (a click,
 * the rubber band, a typed distance along the pointer) goes through the object snaps, tracking,
 * Ortho, Polar and Snap first; overlapping objects offer Selection Cycling's list; a typed END,
 * MID, … at a point prompt is a one-time override.
 */
export function draftedEdit(
  edit: CanvasEditState,
  drafting: Drafting,
  /** Every pickable object under a drawing point (Selection Cycling). */
  candidatesAt: (at: Point) => number[],
): CanvasEditState {
  const special = edit.editing && edit.wantsPoint ? drafting.special : null;
  // FROM measures from its base point, Mid Between 2 Points from its first (Ortho, Polar start there).
  const reference = special ? (special.kind === 'from' ? special.base : special.first) : null;
  const ctx: PointContext = {
    wants: edit.editing && edit.wantsPoint,
    anchor: reference ?? (edit.anchor ? pt(edit.anchor) : null),
  };
  /** A word that is not an option of the prompt and names an object snap. */
  const isOverride = (word: string) =>
    ctx.wants &&
    word.trim() !== '' &&
    matchOption(edit.prompt.options, word.trim()) === null &&
    drafting.override(word);
  /** A point given to FROM / Mid Between 2 Points: false when it is the point the command takes. */
  const feedSpecial = (q: Pt, give: (point: Point) => void): boolean => {
    if (!special) return false;
    if (special.kind === 'from') {
      if (special.base === null) {
        drafting.setSpecial({ kind: 'from', base: q });
        return true;
      }
    } else if (special.first === null) {
      drafting.setSpecial({ kind: 'm2p', first: q });
      return true;
    } else {
      drafting.setSpecial(null);
      give(xy([(special.first[0] + q[0]) / 2, (special.first[1] + q[1]) / 2]));
      return true;
    }
    drafting.setSpecial(null);
    give(xy(q));
    return true;
  };
  /** A typed point at the FROM / M2P prompts (x,y  @dx,dy  @d<a); true when it was one. */
  const typedSpecial = (): boolean => {
    if (!special || edit.input.trim() === '') return false;
    const entry = parseEntry(edit.input, reference ? xy(reference) : null);
    if (entry.kind !== 'point') return false;
    edit.setInput('');
    return feedSpecial(pt(entry.point), (point) => edit.pick(null, point, false));
  };
  const prompt: CanvasEditState['prompt'] = special
    ? {
        key:
          special.kind === 'from'
            ? special.base === null
              ? 'fromBase'
              : 'fromOffset'
            : special.first === null
              ? 'm2pFirst'
              : 'm2pSecond',
        options: [],
        fallback: null,
      }
    : edit.prompt;
  return {
    ...edit,
    prompt,
    // The canvas reports every move: the coordinates and the snap markers follow the pointer.
    tracking: true,
    hover: (at) => {
      if (!ctx.wants && drafting.special) drafting.setSpecial(null);
      const p = drafting.move(pt(at), ctx);
      if (edit.tracking) edit.hover(xy(p));
    },
    pick: (entity, at, additive) => {
      if (ctx.wants) {
        const q = drafting.take(pt(at), ctx);
        if (feedSpecial(q, (point) => edit.pick(null, point, additive))) return;
        edit.pick(entity, xy(q), additive);
        return;
      }
      if (edit.editing && drafting.settings.selectionCycling) {
        const found = candidatesAt(at);
        if (found.length > 1) {
          drafting.setCycle({
            at,
            candidates: found,
            choose: (index) => {
              drafting.setCycle(null);
              edit.pick(index, at, additive);
            },
          });
          return;
        }
      }
      edit.pick(entity, at, additive);
    },
    key: (k, ctrl) => {
      if ((k === 'Tab' || (ctrl && k === '0')) && drafting.key(k, ctrl)) return true;
      if (k === 'Escape' && drafting.special) {
        drafting.setSpecial(null);
        return true;
      }
      if ((k === 'Enter' || k === ' ') && !edit.textEntry) {
        if (isOverride(edit.input)) {
          edit.setInput('');
          return true;
        }
        if (typedSpecial()) return true;
      }
      return edit.key(k, ctrl);
    },
    // The Arabic keyboard layout types the commands by key position (round 2, item 27).
    setInput: (value) => edit.setInput(edit.textEntry ? value : latinize(value)),
    submit: () => {
      if (isOverride(edit.input)) {
        edit.setInput('');
        return;
      }
      if (typedSpecial()) return;
      edit.submit();
    },
  };
}
