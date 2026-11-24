'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import type { CommandId } from '../model/cad-commands';

/**
 * AutoCAD's right-click menu on picked objects (owner 2026-11-24), with only the items the owner
 * chose: Isolate ▸, Erase, Move, Copy Selection, Scale, Rotate, Draw Order ▸, Group ▸,
 * Add Selected, Select Similar, Deselect All, Properties. Isolate is for the screen only.
 */

type Sub = 'isolate' | 'order' | 'group';

interface Item {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
  sub?: Sub;
  separatorBefore?: boolean;
}

const MENU =
  'min-w-52 rounded-sm border border-[#a0a0a0] bg-[#f2f2f2] py-1 text-[13px] text-[#1b1b1b] shadow-[2px_2px_6px_rgba(0,0,0,0.45)]';

function Icon({ children, color = '#2f6db5' }: { children: ReactNode; color?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ICON: Partial<Record<string, ReactNode>> = {
  erase: (
    <Icon color="#c0392b">
      <path d="M8 20h12M4 15 13 6l6 6-7 7H8z" />
    </Icon>
  ),
  move: (
    <Icon color="#333">
      <path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
    </Icon>
  ),
  copy: (
    <Icon>
      <circle cx="8" cy="8" r="4" />
      <circle cx="16" cy="16" r="4" />
    </Icon>
  ),
  scale: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" />
      <rect x="3" y="12" width="9" height="9" />
    </Icon>
  ),
  rotate: (
    <Icon color="#333">
      <path d="M19 12a7 7 0 1 1-2-4.9M19 4v4h-4" />
    </Icon>
  ),
  addSelected: (
    <Icon color="#2e7d32">
      <circle cx="7" cy="7" r="3" fill="#2e7d32" />
      <circle cx="17" cy="17" r="3" fill="#2f6db5" stroke="#2f6db5" />
    </Icon>
  ),
  similar: (
    <Icon color="#2e7d32">
      <rect x="3" y="5" width="12" height="9" fill="#2e7d32" />
      <path d="M14 13l6 6M14 13v5M14 13h5" stroke="#333" />
    </Icon>
  ),
  deselect: (
    <Icon color="#c0392b">
      <path d="M4 4l7 7M11 4l-7 7" />
      <path d="M14 13l6 6M14 13v5M14 13h5" stroke="#333" />
    </Icon>
  ),
  properties: (
    <Icon color="#333">
      <rect x="4" y="4" width="16" height="16" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </Icon>
  ),
  isolate: (
    <Icon>
      <rect x="4" y="4" width="8" height="8" />
      <path d="M14 14h6v6h-6z" strokeDasharray="2 2" />
    </Icon>
  ),
};

export function CanvasContextMenu({
  viewer,
  x,
  y,
  onClose,
}: {
  viewer: DrawingViewer;
  /** Where the right click was, in canvas pixels. */
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { edit, isolation, size } = viewer;
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Sub | null>(null);
  const label = (key: string) => t(`design.cad.menu.${key}` as MessageKey);
  const later = (part: string) => t('design.cad.menu.comingIn', { part });

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // With nothing picked the menu still ends an isolation (as AutoCAD's).
  const none = edit.chosenCount === 0;
  const visible = edit.editing && (!none || isolation.active);
  useEffect(() => {
    if (visible) {
      ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])')?.focus();
    }
  }, [visible]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  if (!visible) return null;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const command = (id: CommandId) => act(() => edit.run(id));
  const chosen = edit.chosen;

  const items: Item[] = [
    { key: 'isolate', label: label('isolate'), icon: ICON.isolate, sub: 'isolate' },
    { key: 'erase', label: label('erase'), icon: ICON.erase, onSelect: command('erase') },
    { key: 'move', label: label('move'), icon: ICON.move, onSelect: command('move') },
    { key: 'copy', label: label('copySelection'), icon: ICON.copy, onSelect: command('copy') },
    { key: 'scale', label: label('scale'), icon: ICON.scale, onSelect: command('scale') },
    { key: 'rotate', label: label('rotate'), icon: ICON.rotate, onSelect: command('rotate') },
    { key: 'order', label: label('drawOrder'), sub: 'order' },
    { key: 'group', label: label('group'), sub: 'group' },
    {
      key: 'addSelected',
      label: label('addSelected'),
      icon: ICON.addSelected,
      separatorBefore: true,
      disabled: edit.addSelectedCommand === null,
      title: edit.addSelectedCommand === null ? label('addSelectedOne') : undefined,
      onSelect: act(edit.addSelected),
    },
    {
      key: 'similar',
      label: label('selectSimilar'),
      icon: ICON.similar,
      separatorBefore: true,
      onSelect: act(edit.selectSimilar),
    },
    {
      key: 'deselect',
      label: label('deselectAll'),
      icon: ICON.deselect,
      onSelect: act(edit.clearChosen),
    },
    {
      key: 'properties',
      label: label('properties'),
      icon: ICON.properties,
      separatorBefore: true,
      onSelect: act(() => {
        const [first] = chosen;
        if (first !== undefined) viewer.showProperties(first);
      }),
    },
  ];
  const main = none
    ? items.map((item) => (item.key === 'isolate' ? item : { ...item, disabled: true }))
    : items;
  const subs: Record<Sub, Item[]> = {
    isolate: [
      {
        key: 'isolateObjects',
        label: label('isolateObjects'),
        disabled: none,
        onSelect: act(() => {
          isolation.isolate(chosen);
        }),
      },
      {
        key: 'hideObjects',
        label: label('hideObjects'),
        disabled: none,
        onSelect: act(() => {
          isolation.hide(chosen);
          edit.clearChosen();
        }),
      },
      {
        key: 'endIsolation',
        label: label('endIsolation'),
        disabled: !isolation.active,
        onSelect: act(isolation.end),
      },
    ],
    order: ['bringFront', 'sendBack', 'bringAbove', 'sendUnder'].map((key, i) => ({
      key,
      label: label(key),
      separatorBefore: i === 2,
      disabled: true,
      title: later('4'),
    })),
    group: ['groupMake', 'ungroup', 'addToGroup', 'removeFromGroup'].map((key) => ({
      key,
      label: label(key),
      disabled: true,
      title: later('6'),
    })),
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...((event.target as HTMLElement)
        .closest('[role=menu]')
        ?.querySelectorAll<HTMLButtonElement>(':scope > li > [role=menuitem]:not([disabled])') ??
        []),
    ];
    const at = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open && (event.target as HTMLElement).closest('[data-sub]')) setOpen(null);
      else onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  // Keep the menu on the canvas.
  const left = Math.max(0, Math.min(x, size.width - 220));
  const top = Math.max(0, Math.min(y, size.height - 330));

  const row = (item: Item, inSub: boolean) => (
    <li
      key={item.key}
      role="none"
      className={`relative ${item.separatorBefore ? 'mt-1 border-t border-[#c8c8c8] pt-1' : ''}`}
      onPointerEnter={() => {
        if (!inSub) setOpen(item.sub ?? null);
      }}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup={item.sub ? 'menu' : undefined}
        aria-expanded={item.sub ? open === item.sub : undefined}
        disabled={item.disabled}
        title={item.title}
        onClick={item.sub ? () => setOpen(item.sub ?? null) : item.onSelect}
        onKeyDown={(event) => {
          if (item.sub && (event.key === 'ArrowRight' || event.key === 'Enter')) {
            event.preventDefault();
            setOpen(item.sub);
            requestAnimationFrame(() =>
              ref.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-sub=${item.sub}] [role=menuitem]:not([disabled])`,
                )
                ?.focus(),
            );
          } else if (inSub && event.key === 'ArrowLeft') {
            event.preventDefault();
            setOpen(null);
          }
        }}
        className={`flex min-h-7 w-full items-center gap-2 px-2 text-start outline-none hover:bg-[#99c9ef] focus-visible:bg-[#99c9ef] disabled:text-[#9a9a9a] disabled:hover:bg-transparent ${
          item.sub && open === item.sub ? 'bg-[#99c9ef]' : ''
        }`}
      >
        <span className="flex w-5 justify-center">{item.icon ?? null}</span>
        <span className="flex-1 whitespace-nowrap">{item.label}</span>
        {item.sub ? <span aria-hidden="true">›</span> : null}
      </button>
      {item.sub && open === item.sub ? (
        <ul
          role="menu"
          aria-label={item.label}
          data-sub={item.sub}
          className={`absolute top-0 z-50 ${left > size.width - 440 ? 'right-full' : 'left-full'} ${MENU}`}
        >
          {subs[item.sub].map((subItem) => row(subItem, true))}
        </ul>
      ) : null}
    </li>
  );

  return (
    <div
      ref={ref}
      dir="ltr"
      className="absolute z-40"
      style={{ left, top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ul role="menu" aria-label={label('title')} className={MENU}>
        {main.map((item) => row(item, false))}
      </ul>
    </div>
  );
}
