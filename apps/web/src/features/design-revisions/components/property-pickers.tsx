'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DrawingLinetype } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { ACI_PALETTE, aciOf, colorLabel, parseColor, rgbText } from '../model/aci-colors';
import {
  ACI_COLORS,
  LINETYPE_DASH,
  LINETYPE_NAMES,
  LINETYPES,
  LINEWEIGHTS,
  lineweightPx,
} from '../model/cad-commands';
import { BUTTON, Dialog, FIELD } from './workspace-dialogs';

/**
 * The drop-downs of AutoCAD's ribbon Properties panel (owner 2026-11-26, item 34): Object Color
 * with swatches and «More Colors…» (the Select Color dialog: Index Color 1-255 and True Color),
 * Lineweight with line previews, Linetype with pattern previews and «Other…» (the Linetype
 * Manager). What a style cannot carry (ByBlock, Default) is listed greyed with the reason.
 */

const FIELD_DARK = 'bg-[#1d2127] text-[#e8eaed] border border-[#4a505a]';

export interface PickerOption<V> {
  value: V;
  label: string;
  preview?: ReactNode;
  /** Greyed with this reason in its tooltip. */
  disabled?: string;
  /** Opens a dialog instead of choosing a value («More Colors…», «Other…»). */
  more?: boolean;
}

/** One drop-down: a button with the value shown, and a list of options under it. */
export function Picker<V>({
  label,
  title,
  shown,
  preview,
  options,
  selected,
  onChoose,
  onMore,
  disabled,
  width = 'w-44',
}: {
  label: string;
  title?: string;
  shown: string;
  preview?: ReactNode;
  options: readonly PickerOption<V>[];
  selected: V | undefined;
  onChoose: (value: V) => void;
  onMore?: () => void;
  disabled?: boolean;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title ?? label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        className={`flex min-h-7 ${width} items-center gap-1.5 rounded px-1 text-xs disabled:opacity-50 ${FIELD_DARK}`}
      >
        {preview}
        <span className="flex-1 truncate text-start">{shown}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          role="listbox"
          aria-label={label}
          className={`absolute start-0 top-full z-40 mt-0.5 max-h-72 min-w-full overflow-y-auto rounded py-1 shadow-lg ${FIELD_DARK}`}
        >
          {options.map((option) => (
            <li key={option.label} role="none">
              <button
                type="button"
                role="option"
                aria-selected={!option.more && option.value === selected}
                aria-disabled={option.disabled !== undefined}
                title={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  setOpen(false);
                  if (option.more) onMore?.();
                  else onChoose(option.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setOpen(false);
                }}
                className={`flex min-h-7 w-full cursor-default items-center gap-2 whitespace-nowrap px-2 text-start text-xs ${
                  option.disabled ? 'opacity-40' : 'hover:bg-white/10'
                } ${option.more ? 'border-t border-[#4a505a]' : ''} ${
                  !option.more && option.value === selected ? 'font-bold' : ''
                }`}
              >
                {option.preview}
                <span>{option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const Swatch = ({ color }: { color: string | null }) => (
  <span
    aria-hidden="true"
    className="inline-block size-3 shrink-0 border border-white/50"
    style={{ background: color ?? 'linear-gradient(135deg, #fff 0 50%, #000 50% 100%)' }}
  />
);

export function LinePreview({
  linetype,
  weight = null,
}: {
  linetype: DrawingLinetype | null;
  weight?: number | null;
}) {
  const dash = LINETYPE_DASH[linetype ?? 'continuous'];
  const px = weight === null ? 1 : Math.min(8, lineweightPx(weight));
  return (
    <svg aria-hidden="true" width="56" height="10" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2="55"
        y2="5"
        stroke="currentColor"
        strokeWidth={px}
        strokeDasharray={dash.length > 0 ? dash.map((v) => v / 2).join(' ') : undefined}
      />
    </svg>
  );
}

/** A fixed layer over the page for a modal dialog of the ribbon. */
function Modal({ children }: { children: ReactNode }) {
  return <div className="fixed inset-0 z-50 bg-black/20">{children}</div>;
}

/** Object Color: ByLayer, ByBlock, the seven named colours, More Colors… (item 34). */
export function ColorPicker({
  value,
  onChange,
  title,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  title?: string;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState(false);
  const options: PickerOption<string | null>[] = [
    { value: null, label: t('design.cad.byLayer'), preview: <Swatch color={null} /> },
    {
      value: 'byblock',
      label: t('design.cad.byBlock'),
      preview: <Swatch color={null} />,
      disabled: t('design.cad.byBlockNo'),
    },
    ...ACI_COLORS.slice(0, 7).map((c) => ({
      value: c.hex,
      label: c.name,
      preview: <Swatch color={c.hex} />,
    })),
  ];
  if (value !== null && !options.some((o) => o.value === value))
    options.push({ value, label: colorLabel(value), preview: <Swatch color={value} /> });
  options.push({ value: null, label: t('design.cad.moreColors'), more: true });
  return (
    <>
      <Picker
        label={t('design.cad.color')}
        title={title}
        shown={value === null ? t('design.cad.byLayer') : colorLabel(value)}
        preview={<Swatch color={value} />}
        options={options}
        selected={value}
        onChoose={onChange}
        onMore={() => setDialog(true)}
      />
      {dialog ? (
        <Modal>
          <ColorDialog
            value={value}
            onClose={() => setDialog(false)}
            onPick={(color) => {
              setDialog(false);
              onChange(color);
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}

/** AutoCAD's Select Color dialog: Index Color (ACI 1-255, ByLayer) and True Color (r,g,b). */
export function ColorDialog({
  value,
  onPick,
  onClose,
}: {
  value: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'index' | 'true'>('index');
  const [chosen, setChosen] = useState<string | null>(value);
  const [typed, setTyped] = useState(value ? rgbText(value) : '');
  const typedColor = parseColor(typed);
  const swatch = (aci: number) => {
    const hex = ACI_PALETTE[aci - 1]?.hex as string;
    const name = t('design.cad.colorDialog.aci', { n: aci });
    return (
      <button
        key={aci}
        type="button"
        aria-label={name}
        title={name}
        aria-pressed={chosen === hex && aciOf(hex) === aci}
        onClick={() => {
          setChosen(hex);
          setTyped(rgbText(hex));
        }}
        className="size-3.5 border border-black/40 aria-pressed:outline-2 aria-pressed:outline-white"
        style={{ backgroundColor: hex }}
      />
    );
  };
  // AutoCAD lays 10-249 out as 24 columns of hues, the shades down (even rows over odd).
  const grid: number[][] = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9].map((shade) =>
    Array.from({ length: 24 }, (_, h) => 10 + h * 10 + shade),
  );
  return (
    <Dialog title={t('design.cad.colorDialog.title')} onClose={onClose}>
      <div role="tablist" className="flex gap-1">
        {(['index', 'true'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`${BUTTON} ${tab === key ? 'bg-white/10' : ''}`}
          >
            {key === 'index'
              ? t('design.cad.colorDialog.index')
              : t('design.cad.colorDialog.trueColor')}
          </button>
        ))}
      </div>
      {tab === 'index' ? (
        <div className="flex flex-col gap-1" dir="ltr">
          {grid.map((row, i) => (
            <div key={i} className="flex gap-px">
              {row.map(swatch)}
            </div>
          ))}
          <div className="mt-1 flex gap-1">{[1, 2, 3, 4, 5, 6, 7, 8, 9].map(swatch)}</div>
          <div className="flex gap-1">{[250, 251, 252, 253, 254, 255].map(swatch)}</div>
          <button
            type="button"
            aria-pressed={chosen === null}
            onClick={() => {
              setChosen(null);
              setTyped('');
            }}
            className={`${BUTTON} self-start`}
          >
            {t('design.cad.byLayer')}
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          <span>{t('design.cad.colorDialog.rgb')}</span>
          <input
            dir="ltr"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              const parsed = parseColor(event.target.value);
              if (parsed) setChosen(parsed);
            }}
            className={`${FIELD} w-36 font-mono`}
          />
        </label>
        <Swatch color={chosen} />
        <span dir="ltr">{chosen === null ? t('design.cad.byLayer') : colorLabel(chosen)}</span>
      </div>
      {typed.trim() !== '' && typedColor === null ? (
        <p role="status" className="text-xs text-[#ff8a80]">
          {t('design.cad.colorDialog.bad')}
        </p>
      ) : null}
      <div className="flex justify-end gap-1">
        <button type="button" className={BUTTON} onClick={() => onPick(chosen)}>
          {t('design.cad.colorDialog.ok')}
        </button>
        <button type="button" className={BUTTON} onClick={onClose}>
          {t('design.cad.colorDialog.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

/** AutoCAD's descriptions of the loaded line types. */
const LINETYPE_DESCRIPTION: Readonly<Record<DrawingLinetype, string>> = {
  continuous: 'Solid line',
  dashed: 'Dashed __ __ __ __',
  dotted: 'Dot . . . . . . .',
  center: 'Center ____ _ ____ _',
};

/** Linetype: ByLayer, ByBlock, Continuous, the loaded types, Other… (the Linetype Manager). */
export function LinetypePicker({
  value,
  onChange,
  onCurrent,
  title,
}: {
  value: DrawingLinetype | null;
  onChange: (linetype: DrawingLinetype | null) => void;
  /** The Linetype Manager's «Current» (CELTYPE). */
  onCurrent: (linetype: DrawingLinetype | null) => void;
  title?: string;
}) {
  const { t } = useI18n();
  const [manager, setManager] = useState(false);
  const options: PickerOption<DrawingLinetype | null | 'byblock'>[] = [
    { value: null, label: t('design.cad.byLayer'), preview: <LinePreview linetype={null} /> },
    {
      value: 'byblock',
      label: t('design.cad.byBlock'),
      preview: <LinePreview linetype={null} />,
      disabled: t('design.cad.byBlockNo'),
    },
    ...LINETYPES.map((lt) => ({
      value: lt,
      label: LINETYPE_NAMES[lt],
      preview: <LinePreview linetype={lt} />,
    })),
    { value: null, label: t('design.cad.otherLinetype'), more: true },
  ];
  return (
    <>
      <Picker
        label={t('design.cad.linetype')}
        title={title}
        shown={value ? LINETYPE_NAMES[value] : t('design.cad.byLayer')}
        preview={<LinePreview linetype={value} />}
        options={options}
        selected={value}
        onChoose={(v) => {
          if (v !== 'byblock') onChange(v);
        }}
        onMore={() => setManager(true)}
      />
      {manager ? (
        <Modal>
          <LinetypeManager
            current={value}
            onClose={() => setManager(false)}
            onCurrent={(lt) => {
              setManager(false);
              onCurrent(lt);
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}

/** AutoCAD's Linetype Manager: the loaded line types with their look; Current sets CELTYPE. */
export function LinetypeManager({
  current,
  onCurrent,
  onClose,
}: {
  current: DrawingLinetype | null;
  onCurrent: (linetype: DrawingLinetype | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<DrawingLinetype | null>(current);
  const [now, setNow] = useState<DrawingLinetype | null>(current);
  const name = (lt: DrawingLinetype | null) => (lt ? LINETYPE_NAMES[lt] : 'ByLayer');
  const rows: { lt: DrawingLinetype | null; description: string; disabled?: string }[] = [
    { lt: null, description: '' },
    ...LINETYPES.map((lt) => ({ lt, description: LINETYPE_DESCRIPTION[lt] })),
  ];
  return (
    <Dialog title={t('design.cad.linetypeManager.title')} onClose={onClose}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled
          title={t('design.cad.linetypeManager.loadNo')}
          className={BUTTON}
        >
          {t('design.cad.linetypeManager.load')}
        </button>
        <button type="button" className={BUTTON} onClick={() => setNow(chosen)}>
          {t('design.cad.linetypeManager.current')}
        </button>
      </div>
      <p className="text-xs" dir="ltr">
        {t('design.cad.linetypeManager.currentIs', { name: name(now) })}
      </p>
      <table className="w-full text-xs" dir="ltr">
        <thead>
          <tr className="text-start">
            <th className="text-start font-semibold">{t('design.cad.linetypeManager.name')}</th>
            <th className="text-start font-semibold">
              {t('design.cad.linetypeManager.appearance')}
            </th>
            <th className="text-start font-semibold">
              {t('design.cad.linetypeManager.description')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="opacity-40" title={t('design.cad.byBlockNo')}>
            <td>ByBlock</td>
            <td />
            <td />
          </tr>
          {rows.map((row) => (
            <tr
              key={name(row.lt)}
              aria-selected={chosen === row.lt}
              onClick={() => setChosen(row.lt)}
              className={`cursor-default ${chosen === row.lt ? 'bg-[#3d6fb6] text-white' : 'hover:bg-white/10'}`}
            >
              <td>
                <button
                  type="button"
                  onClick={() => setChosen(row.lt)}
                  className="min-h-7 text-start"
                >
                  {name(row.lt)}
                </button>
              </td>
              <td>
                <LinePreview linetype={row.lt} />
              </td>
              <td>{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end gap-1">
        <button type="button" className={BUTTON} onClick={() => onCurrent(now)}>
          {t('design.cad.linetypeManager.ok')}
        </button>
        <button type="button" className={BUTTON} onClick={onClose}>
          {t('design.cad.linetypeManager.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

/** Lineweight: ByLayer, ByBlock, Default, 0.00 … 2.11 mm, each with its line. */
export function LineweightPicker({
  value,
  onChange,
  title,
}: {
  value: number | null;
  onChange: (weight: number | null) => void;
  title?: string;
}) {
  const { t } = useI18n();
  const mm = (w: number) => `${w.toFixed(2)} mm`;
  const options: PickerOption<number | null | 'special'>[] = [
    { value: null, label: t('design.cad.byLayer'), preview: <LinePreview linetype={null} /> },
    {
      value: 'special',
      label: t('design.cad.byBlock'),
      preview: <LinePreview linetype={null} />,
      disabled: t('design.cad.byBlockNo'),
    },
    {
      value: 'special',
      label: t('design.cad.lwDefault'),
      preview: <LinePreview linetype={null} />,
      disabled: t('design.cad.lwDefaultNo'),
    },
    ...LINEWEIGHTS.map((w) => ({
      value: w,
      label: mm(w),
      preview: <LinePreview linetype={null} weight={w} />,
    })),
  ];
  return (
    <Picker
      label={t('design.cad.lineweight')}
      title={title}
      shown={value === null ? t('design.cad.byLayer') : mm(value)}
      preview={<LinePreview linetype={null} weight={value} />}
      options={options}
      selected={value}
      onChoose={(v) => {
        if (v !== 'special') onChange(v);
      }}
    />
  );
}
