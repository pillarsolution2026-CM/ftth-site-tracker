'use client';

import { useEffect, useState } from 'react';

export type CrosshairSize = 'small' | 'full';

/** Where this browser keeps the choice (owner 2026-11-26: «Keep the choice in the browser»). */
export const CROSSHAIR_STORAGE_KEY = 'ftth.cad.crosshair';

function readStored(): CrosshairSize {
  try {
    return window.localStorage.getItem(CROSSHAIR_STORAGE_KEY) === 'small' ? 'small' : 'full';
  } catch {
    return 'full';
  }
}

/**
 * AutoCAD's CURSORSIZE on the tab strip: the crosshair across the whole drawing (100, the default
 * look) or a small cross with short arms and the pick box (5). Remembered in this browser.
 */
export function useCrosshairSize(): { size: CrosshairSize; toggle: () => void } {
  const [size, setSize] = useState<CrosshairSize>('full');
  // Read after mounting: the server render knows no localStorage.
  useEffect(() => {
    setSize(readStored());
  }, []);
  const toggle = () => {
    const next: CrosshairSize = size === 'full' ? 'small' : 'full';
    setSize(next);
    try {
      window.localStorage.setItem(CROSSHAIR_STORAGE_KEY, next);
    } catch {
      // Storage refused (private window): the choice lasts for this page only.
    }
  };
  return { size, toggle };
}
