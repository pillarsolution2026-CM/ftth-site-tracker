'use client';

import { useEffect, useRef } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import type { SnapMode } from '../model/object-snap';

/**
 * AutoCAD's Shift + right-click menu at a point prompt (round 2, item 28): the one-time Object Snap
 * overrides — From, Mid Between 2 Points, Endpoint, Midpoint, Intersection, Apparent Intersection,
 * Extension, Center, Quadrant, Tangent, Perpendicular, Parallel, Insertion, Node, Nearest, None —
 * and the Object Snap Settings. A choice is the same as typing its name (END, MID, … FROM, M2P).
 */

interface Entry {
  key: string;
  label: string;
  word?: string;
  settings?: boolean;
  separatorBefore?: boolean;
}

const MODES: readonly { mode: SnapMode; word: string }[] = [
  { mode: 'endpoint', word: 'END' },
  { mode: 'midpoint', word: 'MID' },
  { mode: 'intersection', word: 'INT' },
  { mode: 'apparentIntersection', word: 'APP' },
  { mode: 'extension', word: 'EXT' },
  { mode: 'center', word: 'CEN' },
  { mode: 'quadrant', word: 'QUA' },
  { mode: 'tangent', word: 'TAN' },
  { mode: 'perpendicular', word: 'PER' },
  { mode: 'parallel', word: 'PAR' },
  { mode: 'insertion', word: 'INS' },
  { mode: 'node', word: 'NOD' },
  { mode: 'nearest', word: 'NEA' },
];

export function SnapMenu({
  viewer,
  x,
  y,
  onClose,
}: {
  viewer: DrawingViewer;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [onClose]);

  const entries: Entry[] = [
    { key: 'from', label: t('design.cad.status.snapFrom'), word: 'FROM' },
    { key: 'm2p', label: t('design.cad.status.snapM2p'), word: 'M2P' },
    ...MODES.map(({ mode, word }, i) => ({
      key: mode,
      label: t(`design.cad.status.mode.${mode}` as MessageKey),
      word,
      separatorBefore: i === 0,
    })),
    { key: 'none', label: t('design.cad.status.snapNone'), word: 'NON', separatorBefore: true },
    {
      key: 'settings',
      label: t('design.cad.status.osnapSettings'),
      settings: true,
      separatorBefore: true,
    },
  ];
  const choose = (entry: Entry) => {
    if (entry.settings) viewer.drafting.openDialog('osnap');
    else if (entry.word) viewer.drafting.override(entry.word);
    onClose();
  };
  return (
    <div
      ref={ref}
      dir="ltr"
      className="absolute z-40"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <ul
        role="menu"
        aria-label={t('design.cad.status.snapMenu')}
        className="min-w-52 rounded-sm border border-[#a0a0a0] bg-[#f2f2f2] py-1 text-[13px] text-[#1b1b1b] shadow-[2px_2px_6px_rgba(0,0,0,0.45)]"
      >
        {entries.map((entry) => (
          <li key={entry.key} role="none">
            {entry.separatorBefore ? <hr className="my-1 border-[#c8c8c8]" /> : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(entry)}
              className="flex min-h-7 w-full items-center px-4 text-start hover:bg-[#cfe3fb] focus-visible:bg-[#cfe3fb]"
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
