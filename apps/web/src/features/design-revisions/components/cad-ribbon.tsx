'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ltr, type MessageKey } from '@ftth/i18n';
import type { DrawingLinetype } from '@ftth/shared';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { LayerRow } from '../hooks/use-drawing-viewer';
import { formatPrompt, type CanvasEditState } from '../hooks/use-canvas-edit';
import {
  ACI_COLORS,
  COMMANDS,
  LINETYPE_NAMES,
  LINETYPES,
  LINEWEIGHTS,
  type CommandId,
} from '../model/cad-commands';

/**
 * The AutoCAD-like workspace of the drawing (ADR-051): a dark ribbon laid out as AutoCAD's Home tab
 * (Draw | Modify | Annotation | Layers | Properties) and the command line under the canvas. The pen
 * on the canvas opens it; nothing is kept until «حفظ». The icons are this program's own.
 */

const DARK = {
  bar: 'bg-[#2b2f36] text-[#e8eaed] border-[#1b1e23]',
  tile: 'text-[#e8eaed] hover:bg-white/10',
  on: 'bg-[#3d6fb6] text-white',
  field: 'bg-[#1d2127] text-[#e8eaed] border border-[#4a505a]',
};

/** The pen on the canvas toolbar: opens the workspace. */
export function PenButton({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  if (!edit.available || edit.editing) return null;
  return (
    <CanvasButton label={t('design.edit.start')} onClick={edit.start}>
      <Svg>
        <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
        <path d="M14 6l3 3" />
      </Svg>
    </CanvasButton>
  );
}

/** A dark square button on the canvas (zoom, palettes, pen). */
export function CanvasButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex min-h-10 min-w-10 items-center justify-center rounded border border-[#4a505a] px-2 text-lg focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
        pressed ? DARK.on : 'bg-[#2b2f36]/95 text-[#e8eaed] hover:bg-[#3a3f47]'
      }`}
    >
      {children}
    </button>
  );
}

function Svg({ children, size = 'size-5' }: { children: ReactNode; size?: string }) {
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

/** This program's own drawings of the commands (in the spirit of a CAD ribbon). */
const ICONS: Record<CommandId | 'undo', ReactNode> = {
  line: (
    <>
      <path d="M4 19 19 5" />
      <rect x="2.5" y="17.5" width="3" height="3" />
      <rect x="17.5" y="3.5" width="3" height="3" />
    </>
  ),
  pline: (
    <>
      <path d="M3 18 8 8l5 7 8-10" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="13" cy="15" r="1.2" />
    </>
  ),
  circle: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12h8" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  arc: (
    <>
      <path d="M4 18A9 9 0 0 1 20 18" />
      <rect x="2.5" y="16.5" width="3" height="3" />
      <rect x="18.5" y="16.5" width="3" height="3" />
      <rect x="10.5" y="7.2" width="3" height="3" />
    </>
  ),
  rectang: (
    <>
      <rect x="4" y="6" width="16" height="12" />
      <rect x="2.5" y="16.5" width="3" height="3" />
      <rect x="18.5" y="4.5" width="3" height="3" />
    </>
  ),
  point: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
    </>
  ),
  move: (
    <path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" />
      <path d="M15 9V4H4v11h5" />
    </>
  ),
  stretch: (
    <>
      <path d="M3 17h7l4-8h7" />
      <rect x="11" y="6" width="10" height="7" strokeDasharray="2 2" />
      <path d="M15 17h5M18 15l2 2-2 2" />
    </>
  ),
  rotate: (
    <>
      <path d="M19 12a7 7 0 1 1-2-4.9" />
      <path d="M19 4v4h-4" />
    </>
  ),
  mirror: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 7 4 17h5zM15 7l5 10h-5z" />
    </>
  ),
  scale: (
    <>
      <rect x="3" y="12" width="9" height="9" />
      <rect x="3" y="3" width="18" height="18" strokeDasharray="2 2" />
      <path d="M12 12l6-6M14 6h4v4" />
    </>
  ),
  trim: (
    <>
      <path d="M12 3v18" />
      <path d="M3 12h9" />
      <path d="M12 12h9" strokeDasharray="2 2" />
      <path d="M16 9l4 6M20 9l-4 6" />
    </>
  ),
  fillet: (
    <>
      <path d="M4 20V12a8 8 0 0 1 8-8h8" />
      <path d="M4 4h4M4 4v4" strokeDasharray="1.5 1.5" />
    </>
  ),
  erase: (
    <>
      <path d="M8 20h12" />
      <path d="M4 15 13 6l6 6-7 7H8z" />
      <path d="M8.5 10.5l6 6" />
    </>
  ),
  offset: (
    <>
      <path d="M3 9c4-4 8 4 12 0s4-3 6-3" />
      <path d="M3 16c4-4 8 4 12 0s4-3 6-3" strokeDasharray="2 2" />
    </>
  ),
  join: (
    <>
      <path d="M3 16 10 9" />
      <path d="M14 9l7 7" />
      <path d="M10 9h4" strokeDasharray="1.5 1.5" />
    </>
  ),
  text: <path d="M5 5h14M12 5v14M9 19h6" />,
  textedit: (
    <>
      <path d="M4 5h10M9 5v10" />
      <path d="M13 20l1-3 6-6 2 2-6 6z" />
    </>
  ),
  dimlinear: (
    <>
      <path d="M4 6v12M20 6v12M4 12h16" />
      <path d="M4 12l3-2v4zM20 12l-3-2v4z" />
    </>
  ),
  leader: (
    <>
      <path d="M4 20 12 10h8" />
      <path d="M4 20l1-4 3 2z" />
    </>
  ),
  layer: (
    <>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M17 17h5M19.5 14.5v5" />
    </>
  ),
  matchprop: (
    <>
      <path d="M14 4l6 6-8 8-6-6z" />
      <path d="M6 12l-3 8 8-3" />
    </>
  ),
  laymcur: (
    <>
      <path d="M12 4 3 9l9 5 9-5z" />
      <path d="M8 17l3 3 6-6" />
    </>
  ),
  laymch: (
    <>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="M5 17h14M15 14l4 3-4 3" />
    </>
  ),
  undo: <path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" />,
};

function shortcutOf(id: CommandId): string {
  const def = COMMANDS[id];
  return def.aliases[0] ?? def.name;
}

function Tile({ edit, id, big = false }: { edit: CanvasEditState; id: CommandId; big?: boolean }) {
  const { t } = useI18n();
  const on = edit.command === id;
  const label = t(`design.cad.tool.${id}` as MessageKey);
  const hint = `${t(`design.cad.hint.${id}` as MessageKey)} — ${COMMANDS[id].name} (${shortcutOf(id)})`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={hint}
      onClick={() => edit.run(id)}
      className={`flex items-center rounded focus-visible:outline-2 focus-visible:outline-(--color-focus) ${
        big
          ? 'min-h-16 min-w-14 flex-col justify-center gap-1 px-1.5 py-1 text-[11px]'
          : 'min-h-8 gap-1.5 px-1.5 text-xs'
      } ${on ? DARK.on : DARK.tile}`}
    >
      <Svg size={big ? 'size-7' : 'size-4'}>{ICONS[id]}</Svg>
      <span dir="ltr" className="whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={title}
      className="flex flex-col border-e border-[#454b55] px-2 last:border-e-0"
    >
      <div className="flex flex-1 flex-wrap items-start gap-0.5">{children}</div>
      <div
        dir="ltr"
        className="mt-1 rounded-sm bg-[#22262c] text-center text-[11px] text-[#aab0b8]"
      >
        {title}
      </div>
    </div>
  );
}

/** Small tools in AutoCAD's three rows. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="grid grid-flow-col grid-rows-3 gap-x-1">{children}</div>;
}

export function CadRibbon({
  edit,
  rows,
  onToggleLayer,
  onToggleFrozen,
  onToggleLocked,
}: {
  edit: CanvasEditState;
  rows: readonly LayerRow[];
  onToggleLayer: (index: number) => void;
  onToggleFrozen: (index: number) => void;
  onToggleLocked: (index: number) => void;
}) {
  const { t } = useI18n();
  if (!edit.available || !edit.editing) return null;
  const count = edit.edits.length;
  return (
    <div
      role="toolbar"
      aria-label={t('design.cad.ribbon')}
      dir="ltr"
      className={`flex flex-col border ${DARK.bar}`}
    >
      <div className="flex items-end gap-1 bg-[#1f2328] px-2 pt-1 text-xs">
        <span className="rounded-t bg-[#2b2f36] px-3 py-1 font-semibold">
          {t('design.cad.home')}
        </span>
      </div>
      <div className="flex flex-wrap items-stretch gap-y-2 py-1.5">
        <Panel title={t('design.cad.panel.draw')}>
          <Tile edit={edit} id="line" big />
          <Tile edit={edit} id="pline" big />
          <Tile edit={edit} id="circle" big />
          <Tile edit={edit} id="arc" big />
          <Rows>
            <Tile edit={edit} id="rectang" />
            <Tile edit={edit} id="point" />
          </Rows>
        </Panel>
        <Panel title={t('design.cad.panel.modify')}>
          <Rows>
            <Tile edit={edit} id="move" />
            <Tile edit={edit} id="copy" />
            <Tile edit={edit} id="stretch" />
            <Tile edit={edit} id="rotate" />
            <Tile edit={edit} id="mirror" />
            <Tile edit={edit} id="scale" />
            <Tile edit={edit} id="trim" />
            <Tile edit={edit} id="fillet" />
            <Tile edit={edit} id="join" />
            <Tile edit={edit} id="erase" />
            <Tile edit={edit} id="offset" />
          </Rows>
        </Panel>
        <Panel title={t('design.cad.panel.annotation')}>
          <Tile edit={edit} id="text" big />
          <Tile edit={edit} id="dimlinear" big />
          <Rows>
            <Tile edit={edit} id="leader" />
            <Tile edit={edit} id="textedit" />
          </Rows>
        </Panel>
        <Panel title={t('design.cad.panel.layers')}>
          <Tile edit={edit} id="layer" big />
          <div className="flex flex-col gap-1">
            <LayerDropdown
              edit={edit}
              rows={rows}
              onToggleLayer={onToggleLayer}
              onToggleFrozen={onToggleFrozen}
              onToggleLocked={onToggleLocked}
            />
            <div className="flex gap-0.5">
              <Tile edit={edit} id="laymcur" />
              <Tile edit={edit} id="laymch" />
            </div>
          </div>
        </Panel>
        <Panel title={t('design.cad.panel.properties')}>
          <Tile edit={edit} id="matchprop" big />
          <PropertiesControls edit={edit} />
        </Panel>
        <div className="ms-auto flex items-center gap-2 px-2">
          <button
            type="button"
            onClick={edit.undo}
            disabled={!edit.canUndo}
            title={`${t('design.cad.undo')} (Ctrl+Z)`}
            className={`flex min-h-11 min-w-12 flex-col items-center justify-center rounded px-1.5 text-xs disabled:opacity-40 ${DARK.tile}`}
          >
            <Svg>{ICONS.undo}</Svg>
            <span>{t('design.cad.undo')}</span>
          </button>
          <button
            type="button"
            onClick={edit.cancel}
            disabled={edit.saving}
            title={t('design.edit.cancelHint')}
            className="min-h-11 rounded border border-[#5a606a] px-3 text-sm hover:bg-white/10 disabled:opacity-40"
          >
            <span aria-hidden="true">✕ </span>
            {t('design.edit.cancel')}
          </button>
          <button
            type="button"
            onClick={edit.save}
            disabled={edit.saving}
            title={t('design.edit.saveHint')}
            className="min-h-11 rounded bg-[#3d6fb6] px-3 text-sm font-semibold text-white hover:bg-[#4a7fca] disabled:opacity-40"
          >
            {edit.saving
              ? t('design.edit.saving')
              : count > 0
                ? t('design.edit.saveCount', { count: ltr(count) })
                : t('design.edit.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Icons of a layer's screen state, as in AutoCAD's layer list. */
function StateIcon({ kind, on }: { kind: 'on' | 'freeze' | 'lock'; on: boolean }) {
  if (kind === 'on') {
    return (
      <Svg size="size-4">
        <path d="M9 18h6M10 21h4" />
        <path
          d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.6 1 2.5h6c0-.9.2-1.7 1-2.5A6 6 0 0 0 12 3z"
          fill={on ? '#ffd54f' : 'none'}
        />
      </Svg>
    );
  }
  if (kind === 'freeze') {
    return on ? (
      <Svg size="size-4">
        <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="#81d4fa" />
      </Svg>
    ) : (
      <Svg size="size-4">
        <circle cx="12" cy="12" r="4" fill="#ffca28" stroke="#ffca28" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
      </Svg>
    );
  }
  return (
    <Svg size="size-4">
      <rect x="5" y="11" width="14" height="9" rx="1" fill={on ? '#ffca28' : 'none'} />
      <path d={on ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'} />
    </Svg>
  );
}

/**
 * AutoCAD's layer drop-down: the current layer, and the list with on / freeze / lock (screen only)
 * and the colour; choosing a layer with objects picked moves them to it, else makes it current.
 */
function LayerDropdown({
  edit,
  rows,
  onToggleLayer,
  onToggleFrozen,
  onToggleLocked,
}: {
  edit: CanvasEditState;
  rows: readonly LayerRow[];
  onToggleLayer: (index: number) => void;
  onToggleFrozen: (index: number) => void;
  onToggleLocked: (index: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const byName = new Map(rows.map((row) => [row.name, row] as const));
  const names = edit.allLayers;
  const current = byName.get(edit.currentLayer);
  const choose = (name: string) => {
    edit.chooseLayer(name);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('design.cad.currentLayer')}: ${edit.currentLayer || t('design.cad.noLayer')}`}
        onClick={() => setOpen(!open)}
        className={`flex min-h-8 w-60 items-center gap-1.5 rounded px-2 text-xs ${DARK.field}`}
      >
        {current ? (
          <>
            <StateIcon kind="on" on={current.shown} />
            <StateIcon kind="freeze" on={current.frozen} />
            <StateIcon kind="lock" on={current.locked} />
            <span
              aria-hidden="true"
              className="inline-block size-3 shrink-0 border border-white/40"
              style={{ backgroundColor: current.color }}
            />
          </>
        ) : null}
        <span className="flex-1 truncate text-start">
          {edit.currentLayer || t('design.cad.noLayer')}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('design.cad.layerList')}
          className={`absolute start-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded shadow-lg ${DARK.field}`}
        >
          <ul>
            {names.map((name) => {
              const row = byName.get(name);
              const usable = edit.layers.includes(name);
              return (
                <li key={name} className="flex items-center gap-1 px-1 hover:bg-white/10">
                  {row ? (
                    <>
                      <IconToggle
                        label={`${t('design.cad.on')} ${name}`}
                        pressed={row.shown}
                        onClick={() => onToggleLayer(row.index)}
                      >
                        <StateIcon kind="on" on={row.shown} />
                      </IconToggle>
                      <IconToggle
                        label={t('design.cad.freeze', { layer: name })}
                        pressed={row.frozen}
                        onClick={() => onToggleFrozen(row.index)}
                      >
                        <StateIcon kind="freeze" on={row.frozen} />
                      </IconToggle>
                      <IconToggle
                        label={t('design.cad.lock', { layer: name })}
                        pressed={row.locked}
                        onClick={() => onToggleLocked(row.index)}
                      >
                        <StateIcon kind="lock" on={row.locked} />
                      </IconToggle>
                      <span
                        aria-hidden="true"
                        className="inline-block size-3 shrink-0 border border-white/40"
                        style={{ backgroundColor: row.color }}
                      />
                    </>
                  ) : (
                    <span className="w-[5.5rem]" />
                  )}
                  <button
                    type="button"
                    onClick={() => choose(name)}
                    aria-current={name === edit.currentLayer}
                    className={`min-h-8 flex-1 truncate px-1 text-start text-xs ${
                      usable ? '' : 'opacity-60'
                    } ${name === edit.currentLayer ? 'font-bold' : ''}`}
                  >
                    {name}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-[#4a505a] p-1.5 text-[11px] text-[#aab0b8]" dir="auto">
            {t('design.cad.screenLayers')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function IconToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="flex min-h-8 min-w-7 items-center justify-center rounded hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/** Colour, line type, line weight of the picked objects (saved as styles the build ignores). */
function PropertiesControls({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const style = edit.selectionStyle;
  const disabled = style === null;
  const byLayer = t('design.cad.byLayer');
  const title = disabled ? t('design.cad.pickFirst') : t('design.cad.screenOnly');
  const field = `min-h-7 w-44 rounded px-1 text-xs disabled:opacity-50 ${DARK.field}`;
  return (
    <div className="flex flex-col gap-1" title={title}>
      <select
        aria-label={t('design.cad.color')}
        className={field}
        disabled={disabled}
        value={style?.color ?? ''}
        onChange={(event) => edit.setStyle({ color: event.target.value || null })}
      >
        <option value="">{byLayer}</option>
        {ACI_COLORS.map((c) => (
          <option key={c.aci} value={c.hex}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        aria-label={t('design.cad.linetype')}
        className={field}
        disabled={disabled}
        value={style?.linetype ?? ''}
        onChange={(event) =>
          edit.setStyle({ linetype: (event.target.value || null) as DrawingLinetype | null })
        }
      >
        <option value="">{byLayer}</option>
        {LINETYPES.map((lt) => (
          <option key={lt} value={lt}>
            {LINETYPE_NAMES[lt]}
          </option>
        ))}
      </select>
      <select
        aria-label={t('design.cad.lineweight')}
        className={field}
        disabled={disabled}
        value={style?.lineweight === null || style === null ? '' : String(style.lineweight)}
        onChange={(event) =>
          edit.setStyle({
            lineweight: event.target.value === '' ? null : Number(event.target.value),
          })
        }
      >
        <option value="">{byLayer}</option>
        {LINEWEIGHTS.map((w) => (
          <option key={w} value={String(w)}>
            {w.toFixed(2)} mm
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * AutoCAD's command line under the canvas: the last lines, the prompt of the command (its option
 * words can be clicked) and the entry. Enter or Space confirms, Esc cancels.
 */
export function CadCommandLine({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const { focusNonce } = edit;
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);
  if (!edit.available || !edit.editing) return null;
  const name = edit.command ? COMMANDS[edit.command].name : null;
  const { prompt } = edit;
  const text = t(`design.cad.cmd.${prompt.key}` as MessageKey);
  return (
    <div
      role="group"
      aria-label={t('design.cad.commandLine')}
      dir="ltr"
      className="flex flex-col border border-t-0 border-[#1b1e23] bg-[#22262c] font-mono text-xs text-[#d7dbe0]"
    >
      <div role="log" aria-label={t('design.cad.history')} className="px-2 pt-1 opacity-75">
        {edit.history.slice(-3).map((line, i) => (
          <div key={`${edit.history.length}-${i}`} dir="auto" className="truncate text-start">
            {line}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <span aria-hidden="true" className="text-[#7fb2ff]">
          {name ? '▸' : '⌨'}
        </span>
        <span data-testid="cad-prompt" aria-live="polite">
          {prompt.key === 'command' ? (
            text
          ) : (
            <>
              {name} {text}
              {prompt.options.length > 0 ? (
                <>
                  {' '}
                  {t('design.cad.or')} [
                  {prompt.options.map((o, i) => (
                    <span key={o.key}>
                      {i > 0 ? '/' : ''}
                      <button
                        type="button"
                        className="text-[#7fb2ff] underline-offset-2 hover:underline"
                        onClick={() => edit.chooseOption(o.key)}
                      >
                        {o.word}
                      </button>
                    </span>
                  ))}
                  ]
                </>
              ) : null}
              {prompt.fallback !== null ? ` <${prompt.fallback}>` : ''}:
            </>
          )}
        </span>
        <input
          ref={inputRef}
          aria-label={t('design.cad.commandInput')}
          title={formatPrompt(t, name, prompt)}
          value={edit.input}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit.setInput(event.target.value)}
          onKeyDown={(event) => {
            const ctrl = event.ctrlKey || event.metaKey;
            if (
              event.key === 'Enter' ||
              event.key === 'Escape' ||
              (event.key === ' ' && !edit.textEntry) ||
              (ctrl && event.key.toLowerCase() === 'z' && edit.input === '')
            ) {
              event.preventDefault();
              edit.key(event.key, ctrl);
            }
          }}
          className="min-h-8 min-w-48 flex-1 bg-transparent px-1 text-[#ffffff] outline-none placeholder:text-[#7d838c]"
        />
        {edit.edits.length > 0 ? (
          <span className="font-sans opacity-80" dir="auto">
            {t('design.edit.unsaved', { count: ltr(edit.edits.length) })}
          </span>
        ) : null}
      </div>
      {edit.error ? (
        <div className="px-2 pb-2 font-sans" dir="auto">
          <Notice kind="error">{t(edit.error.key, edit.error.params)}</Notice>
        </div>
      ) : null}
    </div>
  );
}
