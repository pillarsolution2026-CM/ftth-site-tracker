'use client';

import { useState, type ReactNode } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { CanvasEditState } from '../hooks/use-canvas-edit';
import { COMMANDS, type CommandId } from '../model/cad-commands';

/**
 * AutoCAD Express Tools' «Text» panel on the ribbon (ADR-055 part 7; owner dropped Arc Aligned and
 * Remote Text): Modify Text ▾ (Change Case, Rotate, Fit; Explode and Justify greyed: the screen
 * has no font outlines nor justification), Convert to Mtext, Auto Number, Enclose in Object, Text
 * Mask, Unmask Text. And AutoCAD's Table tool of the Annotation panel. The icons are this
 * program's own.
 */

const TILE = 'text-[#e8eaed] hover:bg-white/10';
const ON = 'bg-[#3d6fb6] text-white';

const ICONS: Record<string, ReactNode> = {
  tcase: (
    <>
      <path d="M3 18 7 6l4 12M4.5 14h5" />
      <path d="M14 18v-6a2.5 2.5 0 0 1 5 0v6M14 15h5" />
    </>
  ),
  torient: (
    <>
      <path d="M5 17h9" />
      <path d="M8 11l5-5" />
      <path d="M17 7a6 6 0 0 1 2 6" />
      <path d="M19 13l1.5-2M19 13l-2.4-.6" />
    </>
  ),
  textfit: (
    <>
      <path d="M4 12h16M4 12l2.5-2.5M4 12l2.5 2.5M20 12l-2.5-2.5M20 12l-2.5 2.5" />
      <path d="M8 7h8M12 7v3" />
    </>
  ),
  txt2mtxt: (
    <>
      <path d="M4 6h7M4 10h7M4 14h7" />
      <path d="M13 10h3l-1.5-1.5M16 10l-1.5 1.5" />
      <rect x="17" y="5" width="4" height="14" />
    </>
  ),
  tcount: (
    <>
      <path d="M4 7h2v10M4 17h4" />
      <path d="M11 9a2 2 0 1 1 4 0c0 2-4 3-4 8h4" />
      <path d="M18 7h3l-2 4a2.5 2.5 0 1 1-2 4" />
    </>
  ),
  tcircle: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="6" />
      <path d="M8 13h8M12 9v4" />
    </>
  ),
  textmask: (
    <>
      <rect x="3" y="7" width="18" height="10" fill="currentColor" opacity="0.25" />
      <path d="M7 14h10M12 10v4M8 10h8" />
    </>
  ),
  textunmask: (
    <>
      <rect x="3" y="7" width="18" height="10" strokeDasharray="2 2" />
      <path d="M7 14h10M12 10v4M8 10h8" />
    </>
  ),
  txtexp: (
    <>
      <path d="M6 18 10 6l4 12M7.5 14h5" />
      <path d="M16 6l4 4M20 6l-4 4" />
    </>
  ),
  tjust: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M3 8h18M3 12h18M3 16h18M9 8v12M15 8v12" />
    </>
  ),
};

function Svg({ children, size = 'size-4' }: { children: ReactNode; size?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function Tool({ edit, id, big = false }: { edit: CanvasEditState; id: CommandId; big?: boolean }) {
  const { t } = useI18n();
  const label = t(`design.cad.tool.${id}` as MessageKey);
  const on = edit.command === id;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={`${t(`design.cad.hint.${id}` as MessageKey)} — ${COMMANDS[id].name}`}
      onClick={() => edit.run(id)}
      className={`flex items-center rounded focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
        big
          ? 'min-h-16 min-w-14 flex-col justify-center gap-1 px-1.5 py-1 text-[11px]'
          : 'min-h-8 gap-1.5 px-1.5 text-xs'
      } ${on ? ON : TILE}`}
    >
      <Svg size={big ? 'size-7' : 'size-4'}>{ICONS[id]}</Svg>
      <span dir="ltr" className="whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

/** The Table tool of AutoCAD's Annotation panel (opens the Insert Table dialog). */
export function TableTile({ edit }: { edit: CanvasEditState }) {
  return <Tool edit={edit} id="table" />;
}

/** Modify Text ▾ (Express Tools): its working items, and the greyed ones with the reason. */
function ModifyText({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = t('design.cad.tool.modifyText');
  const items: CommandId[] = ['tcase', 'torient', 'textfit'];
  const greyed: { key: 'txtexp' | 'tjust'; reason: string }[] = [
    { key: 'txtexp', reason: t('design.cad.textNoOutlines') },
    { key: 'tjust', reason: t('design.cad.textNoJustify') },
  ];
  return (
    <div className="relative flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} ▾`}
        onClick={() => setOpen(!open)}
        className={`flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs ${
          items.includes(edit.command as CommandId) ? ON : TILE
        }`}
      >
        <Svg>{ICONS.tcase}</Svg>
        <span dir="ltr" className="whitespace-nowrap">
          {label}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          role="menu"
          aria-label={label}
          className="absolute start-0 top-full z-40 mt-0.5 min-w-48 rounded border border-[#4a505a] bg-[#2b2f36] py-1 text-[#e8eaed] shadow-lg"
        >
          {items.map((id) => (
            <li key={id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  edit.run(id);
                }}
                className="flex min-h-8 w-full items-center gap-2 px-2 text-start text-xs hover:bg-white/10"
              >
                <Svg>{ICONS[id]}</Svg>
                <span dir="ltr">{t(`design.cad.tool.${id}` as MessageKey)}</span>
              </button>
            </li>
          ))}
          {greyed.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                disabled
                aria-disabled="true"
                title={item.reason}
                className="flex min-h-8 w-full items-center gap-2 px-2 text-start text-xs opacity-40"
              >
                <Svg>{ICONS[item.key]}</Svg>
                <span dir="ltr">{t(`design.cad.tool.${item.key}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The tools of the «Text» panel (Express Tools); the ribbon wraps them in its panel. */
export function TextTools({ edit }: { edit: CanvasEditState }) {
  return (
    <div className="grid grid-flow-col grid-rows-3 gap-x-1">
      <ModifyText edit={edit} />
      <Tool edit={edit} id="txt2mtxt" />
      <Tool edit={edit} id="tcount" />
      <Tool edit={edit} id="tcircle" />
      <Tool edit={edit} id="textmask" />
      <Tool edit={edit} id="textunmask" />
    </div>
  );
}
