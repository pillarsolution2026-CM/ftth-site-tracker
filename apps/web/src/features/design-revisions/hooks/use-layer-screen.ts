'use client';

import { useEffect, useState } from 'react';

/**
 * AutoCAD's Layers panel for the screen (owner 2026-11-24; ADR-051: on / freeze / lock are not
 * saved): Off, Isolate / Unisolate, Freeze, Lock / Unlock, Turn All On, Thaw All, Previous,
 * named layer states (kept in this browser per file), Layer Walk and locked layer fading.
 */

export interface LayerSnapshot {
  overrides: ReadonlyMap<number, boolean>;
  frozen: ReadonlySet<number>;
  locked: ReadonlySet<number>;
}

export interface LayerScreen {
  off: (layers: readonly number[]) => void;
  /** Only these layers stay on (AutoCAD's LAYISO, «Off» mode). */
  isolate: (layers: readonly number[]) => void;
  unisolate: () => boolean;
  /**
   * Freezes the layers; the current layer is never frozen (AutoCAD): returns false when it was
   * asked for (the others are still frozen).
   */
  freeze: (layers: readonly number[]) => boolean;
  lock: (layers: readonly number[]) => void;
  unlock: (layers: readonly number[]) => void;
  allOn: () => void;
  thawAll: () => void;
  /** LAYERP: back to the layer settings before the last change; false when there is none. */
  previous: () => boolean;
  /** Named layer states («Unsaved Layer State» when none is in force). */
  states: readonly string[];
  current: string | null;
  saveState: (name: string) => void;
  restoreState: (name: string) => void;
  deleteState: (name: string) => void;
  /** Locked layer fading: locked layers are drawn faded by this percent when on. */
  fade: { on: boolean; percent: number };
  setFade: (fade: { on: boolean; percent: number }) => void;
}

const MAX_HISTORY = 30;

/**
 * A named layer state as kept: by layer NAME (audit 7), so it still fits when layers are added on
 * the page or the view lists them in another order. States saved before by index still load.
 */
export interface NamedSnapshot {
  overrides: readonly (readonly [string | number, boolean])[];
  frozen: readonly (string | number)[];
  locked: readonly (string | number)[];
}

export function toNamed(s: LayerSnapshot, nameOf: (index: number) => string): NamedSnapshot {
  const named = (i: number) => nameOf(i) || i;
  return {
    overrides: [...s.overrides].map(([i, on]) => [named(i), on] as const),
    frozen: [...s.frozen].map(named),
    locked: [...s.locked].map(named),
  };
}

export function fromNamed(raw: unknown, indexOf: (name: string) => number): LayerSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { overrides?: unknown; frozen?: unknown; locked?: unknown };
  if (!Array.isArray(r.overrides) || !Array.isArray(r.frozen) || !Array.isArray(r.locked)) {
    return null;
  }
  const index = (key: unknown) =>
    typeof key === 'number' ? key : typeof key === 'string' ? indexOf(key) : -1;
  const overrides = new Map<number, boolean>();
  for (const pair of r.overrides as unknown[]) {
    if (!Array.isArray(pair) || typeof pair[1] !== 'boolean') continue;
    const i = index(pair[0]);
    if (i >= 0) overrides.set(i, pair[1]);
  }
  const set = (list: unknown[]) => new Set(list.map(index).filter((i) => i >= 0));
  return { overrides, frozen: set(r.frozen), locked: set(r.locked) };
}

export function useLayerScreen(input: {
  cadFileId: string;
  /** The drawing's layers and those added on the page (their indexes follow the drawing's). */
  layerCount: number;
  snapshot: LayerSnapshot;
  apply: (snapshot: LayerSnapshot) => void;
  /** Layer index ↔ name, for states kept by name. */
  nameOf?: (index: number) => string;
  indexOf?: (name: string) => number;
  /** The current layer's index (it cannot be frozen); -1 when none. */
  currentLayer?: () => number;
}): LayerScreen {
  const { snapshot, apply, layerCount } = input;
  const nameOf = input.nameOf ?? (() => '');
  const indexOf = input.indexOf ?? (() => -1);
  const storageKey = `ftth.layerStates.${input.cadFileId}`;
  const [history, setHistory] = useState<readonly LayerSnapshot[]>([]);
  const [isolated, setIsolated] = useState<LayerSnapshot | null>(null);
  const [saved, setSaved] = useState<ReadonlyMap<string, NamedSnapshot>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [fade, setFade] = useState({ on: true, percent: 50 });

  // Named states live in this browser only (screen settings, never sent to the server).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out = new Map<string, NamedSnapshot>();
      for (const [name, value] of Object.entries(parsed)) {
        if (fromNamed(value, () => -1)) out.set(name, value as NamedSnapshot);
      }
      setSaved(out);
    } catch {
      // No storage (private window): states last for this visit only.
    }
  }, [storageKey]);
  const persist = (next: ReadonlyMap<string, NamedSnapshot>) => {
    setSaved(next);
    try {
      const out: Record<string, unknown> = {};
      for (const [name, s] of next) out[name] = s;
      window.localStorage.setItem(storageKey, JSON.stringify(out));
    } catch {
      // Ignored: see above.
    }
  };

  const change = (next: LayerSnapshot) => {
    setHistory((previous) => [...previous, snapshot].slice(-MAX_HISTORY));
    setCurrent(null);
    apply(next);
  };
  const withOverrides = (layers: readonly number[], shown: boolean) => {
    const overrides = new Map(snapshot.overrides);
    for (const index of layers) overrides.set(index, shown);
    return overrides;
  };
  const all = Array.from({ length: layerCount }, (_, i) => i);

  return {
    off: (layers) => change({ ...snapshot, overrides: withOverrides(layers, false) }),
    isolate: (layers) => {
      const keep = new Set(layers);
      // Isolating again keeps the settings from before the first isolation (LAYUNISO).
      setIsolated((before) => before ?? snapshot);
      const overrides = new Map(snapshot.overrides);
      for (const index of all) overrides.set(index, keep.has(index));
      const frozen = new Set([...snapshot.frozen].filter((i) => !keep.has(i)));
      change({ ...snapshot, overrides, frozen });
    },
    unisolate: () => {
      if (!isolated) return false;
      change(isolated);
      setIsolated(null);
      return true;
    },
    freeze: (layers) => {
      const current = input.currentLayer?.() ?? -1;
      const allowed = layers.filter((i) => i !== current);
      if (allowed.length > 0)
        change({ ...snapshot, frozen: new Set([...snapshot.frozen, ...allowed]) });
      return allowed.length === layers.length;
    },
    lock: (layers) => change({ ...snapshot, locked: new Set([...snapshot.locked, ...layers]) }),
    unlock: (layers) => {
      const drop = new Set(layers);
      change({ ...snapshot, locked: new Set([...snapshot.locked].filter((i) => !drop.has(i))) });
    },
    allOn: () => change({ ...snapshot, overrides: withOverrides(all, true) }),
    thawAll: () => change({ ...snapshot, frozen: new Set() }),
    previous: () => {
      const last = history[history.length - 1];
      if (!last) return false;
      setHistory(history.slice(0, -1));
      setCurrent(null);
      apply(last);
      return true;
    },
    states: [...saved.keys()],
    current,
    saveState: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      persist(new Map(saved).set(trimmed, toNamed(snapshot, nameOf)));
      setCurrent(trimmed);
    },
    restoreState: (name) => {
      const s = fromNamed(saved.get(name), indexOf);
      if (!s) return;
      // The current layer stays thawed (AutoCAD restores the rest).
      const current = input.currentLayer?.() ?? -1;
      change({ ...s, frozen: new Set([...s.frozen].filter((i) => i !== current)) });
      setCurrent(name);
    },
    deleteState: (name) => {
      const next = new Map(saved);
      next.delete(name);
      persist(next);
      if (current === name) setCurrent(null);
    },
    fade,
    setFade,
  };
}
