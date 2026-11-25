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
  freeze: (layers: readonly number[]) => void;
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
const toArray = (s: LayerSnapshot) => ({
  overrides: [...s.overrides],
  frozen: [...s.frozen],
  locked: [...s.locked],
});
const fromArray = (raw: unknown): LayerSnapshot | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { overrides?: unknown; frozen?: unknown; locked?: unknown };
  if (!Array.isArray(r.overrides) || !Array.isArray(r.frozen) || !Array.isArray(r.locked)) {
    return null;
  }
  return {
    overrides: new Map(r.overrides as [number, boolean][]),
    frozen: new Set(r.frozen as number[]),
    locked: new Set(r.locked as number[]),
  };
};

export function useLayerScreen(input: {
  cadFileId: string;
  layerCount: number;
  snapshot: LayerSnapshot;
  apply: (snapshot: LayerSnapshot) => void;
}): LayerScreen {
  const { snapshot, apply, layerCount } = input;
  const storageKey = `ftth.layerStates.${input.cadFileId}`;
  const [history, setHistory] = useState<readonly LayerSnapshot[]>([]);
  const [isolated, setIsolated] = useState<LayerSnapshot | null>(null);
  const [saved, setSaved] = useState<ReadonlyMap<string, LayerSnapshot>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [fade, setFade] = useState({ on: true, percent: 50 });

  // Named states live in this browser only (screen settings, never sent to the server).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out = new Map<string, LayerSnapshot>();
      for (const [name, value] of Object.entries(parsed)) {
        const s = fromArray(value);
        if (s) out.set(name, s);
      }
      setSaved(out);
    } catch {
      // No storage (private window): states last for this visit only.
    }
  }, [storageKey]);
  const persist = (next: ReadonlyMap<string, LayerSnapshot>) => {
    setSaved(next);
    try {
      const out: Record<string, unknown> = {};
      for (const [name, s] of next) out[name] = toArray(s);
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
    freeze: (layers) => change({ ...snapshot, frozen: new Set([...snapshot.frozen, ...layers]) }),
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
      persist(new Map(saved).set(trimmed, snapshot));
      setCurrent(trimmed);
    },
    restoreState: (name) => {
      const s = saved.get(name);
      if (!s) return;
      change(s);
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
