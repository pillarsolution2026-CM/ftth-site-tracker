'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { usePointer, type DraftingTab, type DraftingToggle } from '../hooks/use-drafting';
import {
  formatCoordinates,
  formatLatLong,
  LINEAR_UNITS,
  POLAR_ANGLES,
  STATUS_ITEMS,
  type DraftingSettings,
  type StatusItem,
} from '../model/drafting';
import { OSMODE_BIT, SNAP_MODES, type SnapMode } from '../model/object-snap';

/**
 * AutoCAD's status bar under the drawing, 2D items only (owner 2026-11-26, item 14), in
 * AutoCAD's order: coordinates, MODEL, Grid, Snap ▾, Ortho, Polar ▾, Object Snap Tracking,
 * Object Snap ▾, Dynamic Input, Lineweight, Transparency, Selection Cycling, Selection Filter,
 * Annotation Scale, Units, Quick Properties, Isolate Objects, Clean Screen and the
 * Customization gear. A lit (blue) icon is on, as in AutoCAD; F-keys toggle them anywhere.
 */

const BAR = 'border-[#1b1e23] bg-[#2b2f36] text-[#e8eaed]';
const ON = 'bg-[#3d6fb6]/35 text-[#8cc4ff]';
const OFF = 'text-[#c3c8cf] hover:bg-white/10';
const MENU =
  'absolute bottom-full z-50 mb-1 min-w-48 rounded border border-[#4a505a] bg-[#2b2f36] py-1 text-xs text-[#e8eaed] shadow-xl';
const FIELD = 'min-h-7 rounded border border-[#4a505a] bg-[#1d2127] px-1 text-xs text-[#e8eaed]';
const BUTTON =
  'min-h-8 rounded border border-[#5a606a] px-3 text-xs text-[#e8eaed] hover:bg-white/10 disabled:opacity-40';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  grid: <path d="M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" />,
  snap: (
    <>
      <path d="M5 5h.01M12 5h.01M19 5h.01M5 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01" />
      <path d="M9 10v3a3 3 0 0 0 6 0v-3M9 10h2M13 10h2" />
    </>
  ),
  ortho: <path d="M5 4v15h15M5 19l4-4" />,
  polar: <path d="M4 19h16M4 19l12-12M10 19a6 6 0 0 0-2-4.5" />,
  otrack: (
    <>
      <path d="M8 8h6v6H8z" />
      <path d="M2 11h4M16 11h6" strokeDasharray="1.5 2" />
    </>
  ),
  osnap: (
    <>
      <path d="M7 7h10v10H7z" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    </>
  ),
  dyn: (
    <>
      <path d="M3 6h12v7H3z" />
      <path d="M17 11l4 9-3-2-2 3z" />
    </>
  ),
  // Lines that grow wider, as AutoCAD's lineweight icon.
  lineweight: (
    <>
      <path d="M4 6h16" strokeWidth="1" />
      <path d="M4 11h16" strokeWidth="2" />
      <path d="M4 17h16" strokeWidth="3.4" />
    </>
  ),
  transparency: (
    <>
      <path d="M4 4h11v11H4z" />
      <path d="M9 9h11v11H9z" strokeDasharray="2 1.5" />
    </>
  ),
  selectionCycling: (
    <>
      <path d="M4 8h10v10H4z" />
      <path d="M8 4h12v12" />
      <path d="M17 19l3-3-3-3" />
    </>
  ),
  selectionFilter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  annotationScale: (
    <>
      <path d="M4 18l5-12 5 12M6 14h6" />
      <path d="M16 9h4M16 14h4" />
    </>
  ),
  quickProperties: (
    <>
      <path d="M4 5h16v14H4zM4 9h16" />
      <path d="M7 12.5h4M7 15.5h4M13 12.5h4M13 15.5h4" />
    </>
  ),
  isolate: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.7-1.5 1.6-1.5 2.5h-4c0-.9-.7-1.8-1.5-2.5z" />
    </>
  ),
  cleanScreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};

/** Closes a drop-down on a click outside it or on Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return ref;
}

function Toggle({
  label,
  icon,
  on,
  onClick,
  disabled,
}: {
  label: string;
  icon: string;
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-7 min-w-7 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-(--color-focus) disabled:opacity-35 ${on ? ON : OFF}`}
    >
      <Icon>{ICONS[icon]}</Icon>
    </button>
  );
}

/** A button with AutoCAD's small ▾ next to it: the list it opens sits above the bar. */
function WithMenu({
  menuLabel,
  children,
  menu,
}: {
  menuLabel: string;
  children: ReactNode;
  menu: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative flex items-center">
      {children}
      <button
        type="button"
        aria-label={menuLabel}
        title={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex min-h-7 w-3.5 items-center justify-center rounded text-[10px] ${OFF}`}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div role="menu" aria-label={menuLabel} className={`${MENU} start-0`}>
          {menu(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function MenuCheck({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onChange}
      className="flex w-full items-center gap-2 px-3 py-1 text-start hover:bg-white/10 disabled:opacity-40"
    >
      <span aria-hidden="true" className="w-3 text-[#8cc4ff]">
        {checked ? '✓' : ''}
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1 text-start hover:bg-white/10"
    >
      <span aria-hidden="true" className="w-3" />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

const Separator = () => <div role="separator" className="my-1 border-t border-[#4a505a]" />;

/** The pointer's coordinates: Lat / Long when the file has a coordinate system, else X,Y. */
function Coordinates({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { drafting } = viewer;
  const pointer = usePointer(drafting.store);
  const { settings } = drafting;
  const toLonLat = viewer.osm.toLonLat;
  const geo = settings.coords === 'geo' && toLonLat !== null;
  const at = pointer.resolved?.at ?? pointer.cursor;
  let text = '—';
  if (at && geo && toLonLat) {
    const ll = toLonLat(at[0], at[1]);
    text = formatLatLong(ll.lat, ll.lon);
  } else if (at) text = formatCoordinates(at, settings.units, settings.precision);
  const label =
    toLonLat === null
      ? t('design.cad.status.coordsNoCrs')
      : geo
        ? t('design.cad.status.coordsGeo')
        : t('design.cad.status.coordsXy');
  return (
    <button
      type="button"
      data-testid="status-coords"
      aria-label={label}
      title={label}
      disabled={toLonLat === null}
      onClick={() => drafting.set({ coords: geo ? 'xy' : 'geo' })}
      className={`min-h-7 whitespace-nowrap rounded px-1.5 font-mono text-xs tabular-nums disabled:cursor-default ${OFF}`}
    >
      {geo ? <span className="me-1 font-sans opacity-70">Lat, Long</span> : null}
      <span dir="ltr">{text}</span>
    </button>
  );
}

/** The Drafting Settings dialog (DSETTINGS), its 2D tabs. */
function DraftingSettingsDialog({ viewer, tab }: { viewer: DrawingViewer; tab: DraftingTab }) {
  const { t } = useI18n();
  const { drafting } = viewer;
  const [draft, setDraft] = useState<DraftingSettings>(drafting.settings);
  const [shown, setShown] = useState<DraftingTab>(tab);
  const [newAngle, setNewAngle] = useState('');
  const close = () => drafting.openDialog(null);
  const s = (key: string) => t(`design.cad.status.settings.${key}` as MessageKey);
  const setNumber = (key: keyof DraftingSettings) => (value: string) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) setDraft({ ...draft, [key]: n });
  };
  const mode = (m: SnapMode) => (draft.osmode & bitOf(m)) !== 0;
  const tabs: DraftingTab[] = ['snap', 'polar', 'osnap', 'dyn'];
  const check = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  const number = (label: string, value: number, key: keyof DraftingSettings) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      <input
        type="number"
        dir="ltr"
        min={0}
        step="any"
        defaultValue={value}
        onChange={(e) => setNumber(key)(e.target.value)}
        className={`${FIELD} w-28`}
      />
    </label>
  );
  return (
    <div
      role="dialog"
      aria-label={s('title')}
      dir="ltr"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      className="fixed left-1/2 top-24 z-50 flex w-[30rem] max-w-[95vw] -translate-x-1/2 flex-col rounded border border-[#4a505a] bg-[#2b2f36] text-[#e8eaed] shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-[#4a505a] px-3 py-1.5">
        <span className="text-sm font-semibold">{s('title')}</span>
        <button
          type="button"
          aria-label={t('design.cad.dialogClose', { name: s('title') })}
          onClick={close}
          className="min-h-8 min-w-8 rounded hover:bg-white/10"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-[#4a505a] px-2 pt-2">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={shown === key}
            onClick={() => setShown(key)}
            className={`rounded-t px-2 py-1 text-xs ${shown === key ? 'bg-[#1d2127]' : 'hover:bg-white/10'}`}
          >
            {s(`tab.${key}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex flex-col gap-2 p-3">
        {shown === 'snap' ? (
          <>
            {check(s('snapOn'), draft.snap, (v) => setDraft({ ...draft, snap: v }))}
            {number(s('snapX'), draft.snapX, 'snapX')}
            {number(s('snapY'), draft.snapY, 'snapY')}
            {number(s('polarDistance'), draft.polarDistance, 'polarDistance')}
            <fieldset className="flex gap-3 text-xs">
              <legend className="mb-1">{s('snapType')}</legend>
              {(['grid', 'polar'] as const).map((type) => (
                <label key={type} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="snap-type"
                    checked={draft.snapType === type}
                    onChange={() => setDraft({ ...draft, snapType: type })}
                  />
                  {t(`design.cad.status.${type === 'grid' ? 'gridSnap' : 'polarSnap'}`)}
                </label>
              ))}
            </fieldset>
            {check(s('gridOn'), draft.grid, (v) => setDraft({ ...draft, grid: v }))}
            {number(s('gridX'), draft.gridX, 'gridX')}
            {number(s('gridY'), draft.gridY, 'gridY')}
          </>
        ) : null}
        {shown === 'polar' ? (
          <>
            {check(s('polarOn'), draft.polar, (v) =>
              setDraft({ ...draft, polar: v, ortho: v ? false : draft.ortho }),
            )}
            <label className="flex items-center justify-between gap-2 text-xs">
              {s('increment')}
              <select
                dir="ltr"
                value={draft.polarAngle}
                onChange={(e) => setDraft({ ...draft, polarAngle: Number(e.target.value) })}
                className={`${FIELD} w-28`}
              >
                {POLAR_ANGLES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-xs">{s('additional')}</div>
            <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
              {draft.polarAdditional.map((a) => (
                <li key={a} className="flex items-center justify-between text-xs">
                  <span dir="ltr">{a}</span>
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        polarAdditional: draft.polarAdditional.filter((x) => x !== a),
                      })
                    }
                  >
                    {s('deleteAngle')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <input
                aria-label={s('additional')}
                dir="ltr"
                type="number"
                value={newAngle}
                onChange={(e) => setNewAngle(e.target.value)}
                className={`${FIELD} w-28`}
              />
              <button
                type="button"
                className={BUTTON}
                disabled={!Number.isFinite(Number(newAngle)) || newAngle.trim() === ''}
                onClick={() => {
                  const a = Number(newAngle);
                  if (!draft.polarAdditional.includes(a)) {
                    setDraft({ ...draft, polarAdditional: [...draft.polarAdditional, a] });
                  }
                  setNewAngle('');
                }}
              >
                {s('addAngle')}
              </button>
            </div>
          </>
        ) : null}
        {shown === 'osnap' ? (
          <>
            {check(s('osnapOn'), draft.osnap, (v) => setDraft({ ...draft, osnap: v }))}
            {check(s('otrackOn'), draft.otrack, (v) => setDraft({ ...draft, otrack: v }))}
            <div className="grid grid-cols-2 gap-1">
              {SNAP_MODES.map((m) => (
                <label key={m} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={mode(m)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        osmode: e.target.checked
                          ? draft.osmode | bitOf(m)
                          : draft.osmode & ~bitOf(m),
                      })
                    }
                  />
                  <MarkerIcon mode={m} />
                  {t(`design.cad.status.mode.${m}`)}
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={BUTTON}
                onClick={() =>
                  setDraft({ ...draft, osmode: SNAP_MODES.reduce((s2, m) => s2 | bitOf(m), 0) })
                }
              >
                {s('selectAll')}
              </button>
              <button
                type="button"
                className={BUTTON}
                onClick={() => setDraft({ ...draft, osmode: 0 })}
              >
                {s('clearAll')}
              </button>
            </div>
          </>
        ) : null}
        {shown === 'dyn' ? (
          <>
            {check(s('dynOn'), draft.dyn, (v) => setDraft({ ...draft, dyn: v }))}
            {number(s('aperture'), draft.aperture, 'aperture')}
          </>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[#4a505a] px-3 py-2">
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            drafting.set(draft);
            close();
          }}
        >
          {s('ok')}
        </button>
        <button type="button" className={BUTTON} onClick={close}>
          {s('cancel')}
        </button>
      </div>
    </div>
  );
}

const bitOf = (m: SnapMode) => OSMODE_BIT[m];

/** AutoCAD's AutoSnap marker of a mode, small, for the lists. */
export function MarkerIcon({ mode }: { mode: SnapMode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="-7 -7 14 14"
      className="size-3.5 text-[#5ef05e]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      {markerShape(mode, 5)}
    </svg>
  );
}

/** AutoCAD's AutoSnap marker shapes, centred on 0,0, `r` = half its size. */
export function markerShape(mode: SnapMode, r: number): ReactNode {
  switch (mode) {
    case 'endpoint':
      return <rect x={-r} y={-r} width={2 * r} height={2 * r} />;
    case 'midpoint':
      return <path d={`M0 ${-r}L${r} ${r}H${-r}Z`} />;
    case 'center':
      return <circle r={r} />;
    case 'geometricCenter':
      return (
        <>
          <path d={`M${-r * 0.5} ${-r}H${r * 0.5}L${r} 0L${r * 0.5} ${r}H${-r * 0.5}L${-r} 0Z`} />
          <circle r={r * 0.25} />
        </>
      );
    case 'node':
      return (
        <>
          <circle r={r} />
          <path
            d={`M${-r * 0.7} ${-r * 0.7}L${r * 0.7} ${r * 0.7}M${r * 0.7} ${-r * 0.7}L${-r * 0.7} ${r * 0.7}`}
          />
        </>
      );
    case 'quadrant':
      return <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} />;
    case 'intersection':
      return <path d={`M${-r} ${-r}L${r} ${r}M${r} ${-r}L${-r} ${r}`} />;
    case 'extension':
      return <path d={`M${-r} 0H${r}M0 ${-r}V${r}`} strokeDasharray="1.5 1.5" />;
    case 'insertion':
      return (
        <path d={`M${-r} ${-r}H${r * 0.2}V${-r * 0.2}H${r}V${r}H${-r * 0.2}V${r * 0.2}H${-r}Z`} />
      );
    case 'perpendicular':
      return <path d={`M${-r} ${-r}V${r}H${r}M${-r} 0H0V${r}`} />;
    case 'tangent':
      return (
        <>
          <circle r={r * 0.75} cy={r * 0.25} />
          <path d={`M${-r} ${-r * 0.5}H${r}`} />
        </>
      );
    case 'nearest':
      return <path d={`M${-r} ${-r}H${r}L${-r} ${r}H${r}Z`} />;
    case 'apparentIntersection':
      return (
        <>
          <rect x={-r} y={-r} width={2 * r} height={2 * r} />
          <path d={`M${-r} ${-r}L${r} ${r}M${r} ${-r}L${-r} ${r}`} />
        </>
      );
    case 'parallel':
      return <path d={`M${-r} ${r * 0.4}L${r * 0.4} ${-r}M${-r * 0.4} ${r}L${r} ${-r * 0.4}`} />;
  }
}

/** The status bar under the drawing (and the Drafting Settings dialog when open). */
export function CadStatusBar({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { drafting, edit, isolation } = viewer;
  const { settings } = drafting;
  const st = (key: string, params?: Record<string, string | number>) =>
    t(`design.cad.status.${key}` as MessageKey, params);
  const shown = (item: StatusItem) => !settings.hidden.includes(item);
  const toggle = (which: DraftingToggle) => () => drafting.toggle(which);
  const settingsAt = (tab: DraftingTab, close: () => void) => () => {
    close();
    drafting.openDialog(tab);
  };
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useDismiss(gearOpen, () => setGearOpen(false));
  const picked = edit.chosen;
  return (
    <>
      <div
        role="toolbar"
        aria-label={st('label')}
        dir="ltr"
        className={`flex flex-wrap items-center justify-end gap-0.5 border border-t-0 px-1 py-0.5 ${BAR}`}
      >
        {shown('coordinates') ? <Coordinates viewer={viewer} /> : null}
        <span className="flex-1" />
        {shown('model') ? (
          <span
            title={st('modelHint')}
            className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide"
          >
            {st('model')}
          </span>
        ) : null}
        {shown('grid') ? (
          <Toggle label={st('grid')} icon="grid" on={settings.grid} onClick={toggle('grid')} />
        ) : null}
        {shown('snap') ? (
          <WithMenu
            menuLabel={st('snapMenu')}
            menu={(close) => (
              <>
                <MenuCheck
                  label={st('polarSnap')}
                  checked={settings.snapType === 'polar'}
                  onChange={() => {
                    drafting.set({ snapType: 'polar', snap: true });
                    close();
                  }}
                />
                <MenuCheck
                  label={st('gridSnap')}
                  checked={settings.snapType === 'grid'}
                  onChange={() => {
                    drafting.set({ snapType: 'grid', snap: true });
                    close();
                  }}
                />
                <Separator />
                <MenuItem label={st('snapSettings')} onClick={settingsAt('snap', close)} />
              </>
            )}
          >
            <Toggle label={st('snap')} icon="snap" on={settings.snap} onClick={toggle('snap')} />
          </WithMenu>
        ) : null}
        {shown('ortho') ? (
          <Toggle label={st('ortho')} icon="ortho" on={settings.ortho} onClick={toggle('ortho')} />
        ) : null}
        {shown('polar') ? (
          <WithMenu
            menuLabel={st('polarMenu')}
            menu={(close) => (
              <>
                {POLAR_ANGLES.map((angle) => (
                  <MenuCheck
                    key={angle}
                    label={polarList(angle)}
                    checked={settings.polarAngle === angle}
                    onChange={() => {
                      drafting.set({ polarAngle: angle, polar: true, ortho: false });
                      close();
                    }}
                  />
                ))}
                <Separator />
                <MenuItem label={st('trackingSettings')} onClick={settingsAt('polar', close)} />
              </>
            )}
          >
            <Toggle
              label={st('polar')}
              icon="polar"
              on={settings.polar}
              onClick={toggle('polar')}
            />
          </WithMenu>
        ) : null}
        {shown('otrack') ? (
          <Toggle
            label={st('otrack')}
            icon="otrack"
            on={settings.otrack}
            onClick={toggle('otrack')}
          />
        ) : null}
        {shown('osnap') ? (
          <WithMenu
            menuLabel={st('osnapMenu')}
            menu={(close) => (
              <>
                {SNAP_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={drafting.modes.has(m)}
                    onClick={() => drafting.setMode(m, !drafting.modes.has(m))}
                    className="flex w-full items-center gap-2 px-3 py-1 text-start hover:bg-white/10"
                  >
                    <span aria-hidden="true" className="w-3 text-[#8cc4ff]">
                      {drafting.modes.has(m) ? '✓' : ''}
                    </span>
                    <MarkerIcon mode={m} />
                    <span className="whitespace-nowrap">{st(`mode.${m}`)}</span>
                  </button>
                ))}
                <Separator />
                <MenuItem label={st('osnapSettings')} onClick={settingsAt('osnap', close)} />
              </>
            )}
          >
            <Toggle
              label={st('osnap')}
              icon="osnap"
              on={settings.osnap}
              onClick={toggle('osnap')}
            />
          </WithMenu>
        ) : null}
        {shown('dyn') ? (
          <Toggle label={st('dyn')} icon="dyn" on={settings.dyn} onClick={toggle('dyn')} />
        ) : null}
        {shown('lineweight') ? (
          <Toggle
            label={st('lineweight')}
            icon="lineweight"
            on={settings.lineweight}
            onClick={toggle('lineweight')}
          />
        ) : null}
        {shown('transparency') ? (
          <Toggle
            label={st('transparency')}
            icon="transparency"
            on={settings.transparency}
            onClick={toggle('transparency')}
          />
        ) : null}
        {shown('selectionCycling') ? (
          <Toggle
            label={st('selectionCycling')}
            icon="selectionCycling"
            on={settings.selectionCycling}
            onClick={toggle('selectionCycling')}
          />
        ) : null}
        {shown('selectionFilter') ? (
          <WithMenu
            menuLabel={st('selectionFilter')}
            menu={() => (
              <>
                <MenuCheck label={st('filter.none')} checked onChange={() => undefined} />
                {(['vertex', 'edge', 'face', 'history'] as const).map((f) => (
                  <MenuCheck
                    key={f}
                    label={st(`filter.${f}`)}
                    checked={false}
                    disabled
                    title={st('filter.only3d')}
                    onChange={() => undefined}
                  />
                ))}
              </>
            )}
          >
            <Toggle
              label={st('selectionFilter')}
              icon="selectionFilter"
              on={false}
              onClick={() => undefined}
              disabled
            />
          </WithMenu>
        ) : null}
        {shown('annotationScale') ? (
          <WithMenu
            menuLabel={st('annotationScale')}
            menu={() => (
              <>
                {['1:1', '1:2', '1:5', '1:10', '1:20', '1:50', '1:100'].map((scale) => (
                  <MenuCheck
                    key={scale}
                    label={scale}
                    checked={scale === '1:1'}
                    disabled={scale !== '1:1'}
                    title={st('annotationHint')}
                    onChange={() => undefined}
                  />
                ))}
              </>
            )}
          >
            <span
              title={`${st('annotationScale')} — ${st('annotationHint')}`}
              className="flex min-h-7 items-center gap-1 px-1 text-xs"
            >
              <Icon>{ICONS.annotationScale}</Icon>
              1:1
            </span>
          </WithMenu>
        ) : null}
        {shown('units') ? (
          <WithMenu
            menuLabel={st('units')}
            menu={(close) => (
              <>
                {LINEAR_UNITS.map((u) => (
                  <MenuCheck
                    key={u}
                    label={st(`unit.${u}`)}
                    checked={settings.units === u}
                    onChange={() => {
                      drafting.set({ units: u });
                      close();
                    }}
                  />
                ))}
              </>
            )}
          >
            <span title={st('units')} className="min-h-7 px-1 py-1 text-xs">
              {st(`unit.${settings.units}`)}
            </span>
          </WithMenu>
        ) : null}
        {shown('quickProperties') ? (
          <Toggle
            label={st('quickProperties')}
            icon="quickProperties"
            on={settings.quickProperties}
            onClick={toggle('quickProperties')}
          />
        ) : null}
        {shown('isolate') ? (
          <WithMenu
            menuLabel={st('isolate')}
            menu={(close) => (
              <>
                <MenuItem
                  label={st('isolateObjects')}
                  onClick={() => {
                    if (picked.size > 0) isolation.isolate(picked);
                    close();
                  }}
                />
                <MenuItem
                  label={st('hideObjects')}
                  onClick={() => {
                    if (picked.size > 0) isolation.hide(picked);
                    close();
                  }}
                />
                {isolation.active ? (
                  <MenuItem
                    label={st('endIsolation')}
                    onClick={() => {
                      isolation.end();
                      close();
                    }}
                  />
                ) : null}
              </>
            )}
          >
            <span
              title={st('isolate')}
              className={`flex min-h-7 min-w-7 items-center justify-center rounded ${isolation.active ? 'text-[#ff8a80]' : 'text-[#c3c8cf]'}`}
            >
              <Icon>{ICONS.isolate}</Icon>
            </span>
          </WithMenu>
        ) : null}
        {shown('cleanScreen') ? (
          <Toggle
            label={st('cleanScreen')}
            icon="cleanScreen"
            on={drafting.cleanScreen}
            onClick={() => drafting.setCleanScreen(!drafting.cleanScreen)}
          />
        ) : null}
        <div ref={gearRef} className="relative">
          <button
            type="button"
            aria-label={st('customize')}
            title={st('customize')}
            aria-haspopup="menu"
            aria-expanded={gearOpen}
            onClick={() => setGearOpen(!gearOpen)}
            className={`flex min-h-7 min-w-7 items-center justify-center rounded ${OFF}`}
          >
            <Icon>{ICONS.gear}</Icon>
          </button>
          {gearOpen ? (
            <div role="menu" aria-label={st('customize')} className={`${MENU} end-0`}>
              {STATUS_ITEMS.map((item) => (
                <MenuCheck
                  key={item}
                  label={st(`item.${item}`)}
                  checked={shown(item)}
                  onChange={() =>
                    drafting.set({
                      hidden: shown(item)
                        ? [...settings.hidden, item]
                        : settings.hidden.filter((h) => h !== item),
                    })
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {drafting.dialog ? (
        <DraftingSettingsDialog key={drafting.dialog} viewer={viewer} tab={drafting.dialog} />
      ) : null}
    </>
  );
}

/** «45, 90, 135, 180...» as AutoCAD's Polar drop-down lists each increment. */
export function polarList(increment: number): string {
  return `${[1, 2, 3, 4].map((k) => String(Math.round(increment * k * 1e4) / 1e4)).join(', ')}...`;
}
