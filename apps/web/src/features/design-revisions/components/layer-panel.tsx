'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ltr } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { CanvasEditState } from '../hooks/use-canvas-edit';
import type { LayerRow } from '../hooks/use-drawing-viewer';
import { ACI_COLORS } from '../model/cad-commands';

/**
 * AutoCAD's Layer Properties Manager as a pop-up (ADR-051, owner 2026-11-19): a dark table of the
 * layers — current, name, on, freeze, lock, colour (for this screen only) and, in the edit mode,
 * what the layer means for the build — with New / Delete / Set current / Rename and a search.
 */

const DARK_FIELD = 'bg-[#1d2127] text-[#e8eaed] border border-[#4a505a]';
const NONE = '';
const DRAWING_ONLY = '__drawing__';

export interface LayerManagerProps {
  rows: readonly LayerRow[];
  query: string;
  onQuery: (value: string) => void;
  onToggle: (index: number) => void;
  onSetListed: (shown: boolean) => void;
  onFreeze: (index: number) => void;
  onLock: (index: number) => void;
  onColor: (index: number, color: string | null) => void;
  /** The edit mode: current layer, meaning, new / rename / delete (saved as corrections). */
  edit: CanvasEditState | null;
  onClose: () => void;
  /** Why the last layer change was refused (the current layer cannot be frozen). */
  notice?: string | null;
}

interface Row {
  name: string;
  view: LayerRow | null;
}

export function LayerManager(props: LayerManagerProps) {
  const { rows, query, onQuery, onToggle, onSetListed, onFreeze, onLock, onColor, edit, onClose } =
    props;
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | 'rename' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [like, setLike] = useState(NONE);
  const [message, setMessage] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);
  // Esc closes it wherever the focus is (AutoCAD's palettes close the same way).
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const byName = new Map(rows.map((row) => [row.name, row] as const));
  const names = edit ? edit.allLayers : rows.map((row) => row.name);
  const all: Row[] = names.map((n) => ({ name: n, view: byName.get(n) ?? null }));
  const needle = query.trim().toLowerCase();
  const listed = needle === '' ? all : all.filter((row) => row.name.toLowerCase().includes(needle));
  const current = edit?.currentLayer ?? '';

  const openForm = (next: 'new' | 'rename' | 'delete') => {
    setForm(form === next ? null : next);
    setName(next === 'rename' ? (picked ?? '') : '');
    setLike(NONE);
    setMessage(null);
  };
  const done = (error: string | null) => {
    if (error) setMessage(t(error as 'design.cad.layerExists'));
    else setForm(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('design.cad.manager.title')}
        tabIndex={-1}
        dir="ltr"
        className="flex max-h-[80vh] w-full max-w-5xl flex-col rounded border border-[#1b1e23] bg-[#2b2f36] text-[#e8eaed] shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between bg-[#1f2328] px-3 py-1.5">
          <span className="text-xs font-semibold tracking-wide">
            {t('design.cad.manager.title').toUpperCase()}
          </span>
          <button
            type="button"
            aria-label={t('design.cad.manager.close')}
            title={t('design.cad.manager.close')}
            onClick={onClose}
            className="min-h-8 min-w-8 rounded hover:bg-white/10"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b border-[#454b55] px-2 py-1.5 text-xs">
          {edit ? (
            <>
              <BarButton label={t('design.cad.layerAdd')} onClick={() => openForm('new')}>
                <path d="M12 3 3 8l9 5 9-5z" />
                <path d="M3 13l9 5 9-5" />
                <path d="M18 15v6M15 18h6" />
              </BarButton>
              <BarButton
                label={t('design.cad.layerDelete')}
                disabled={picked === null}
                onClick={() => openForm('delete')}
              >
                <path d="M12 3 3 8l9 5 9-5z" />
                <path d="M3 13l9 5 9-5" />
                <path d="M15 16l5 5M20 16l-5 5" />
              </BarButton>
              <BarButton
                label={t('design.cad.manager.setCurrent')}
                disabled={picked === null}
                onClick={() => picked && edit.chooseLayer(picked)}
              >
                <path d="M5 12l4 4 10-10" />
              </BarButton>
              <BarButton
                label={t('design.cad.layerRename')}
                disabled={picked === null}
                onClick={() => openForm('rename')}
              >
                <path d="M4 20h4L19 9l-4-4L4 16z" />
              </BarButton>
              <span className="mx-2 h-6 w-px bg-[#454b55]" />
            </>
          ) : null}
          <button
            type="button"
            onClick={() => onSetListed(true)}
            className="min-h-8 rounded px-2 hover:bg-white/10"
          >
            {t('design.viewer.allOn')}
          </button>
          <button
            type="button"
            onClick={() => onSetListed(false)}
            className="min-h-8 rounded px-2 hover:bg-white/10"
          >
            {t('design.viewer.allOff')}
          </button>
          <label className="ms-auto flex items-center gap-1">
            <span className="sr-only">{t('design.viewer.layerSearch')}</span>
            <input
              type="search"
              aria-label={t('design.viewer.layerSearch')}
              placeholder={t('design.cad.manager.search')}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              className={`min-h-8 w-56 rounded px-2 ${DARK_FIELD}`}
            />
          </label>
        </div>

        {edit ? (
          <p className="px-3 pt-1.5 text-xs">
            {t('design.cad.manager.current')}: <strong>{current || t('design.cad.noLayer')}</strong>
          </p>
        ) : null}

        {edit && form !== null ? (
          <LayerForm
            edit={edit}
            form={form}
            picked={picked}
            name={name}
            setName={setName}
            like={like}
            setLike={setLike}
            message={message}
            onDone={done}
            onCancel={() => setForm(null)}
          />
        ) : null}

        {props.notice ? (
          <p role="alert" className="border-b border-[#454b55] px-3 py-1.5 text-xs text-[#ffb4a8]">
            {props.notice}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-[#2b2f36] text-[#aab0b8]">
              <tr className="border-b border-[#454b55] text-start">
                <Th>{t('design.cad.manager.status')}</Th>
                <Th>{t('design.cad.manager.name')}</Th>
                <Th>{t('design.cad.on')}</Th>
                <Th>{t('design.cad.manager.freeze')}</Th>
                <Th>{t('design.cad.manager.lock')}</Th>
                <Th>{t('design.cad.color')}</Th>
                {edit ? <Th>{t('design.cad.manager.meaning')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {listed.map(({ name: layer, view }) => (
                <tr
                  key={layer}
                  aria-selected={picked === layer}
                  onClick={() => setPicked(layer)}
                  onDoubleClick={() => edit?.chooseLayer(layer)}
                  className={`border-b border-[#363b43] ${
                    picked === layer ? 'bg-[#3d6fb6]/40' : 'hover:bg-white/5'
                  }`}
                >
                  <td className="px-1.5 py-1 text-center">
                    {current === layer ? (
                      <span aria-label={t('design.cad.current')} className="text-[#7ee07e]">
                        ✔
                      </span>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1">
                    {view ? (
                      <label className="flex min-h-8 items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={view.shown}
                          onChange={() => onToggle(view.index)}
                        />
                        <span className={current === layer ? 'font-bold' : ''}>{layer}</span>
                      </label>
                    ) : (
                      <span className="flex min-h-8 items-center">{layer}</span>
                    )}
                  </td>
                  <td className="px-1.5 py-1">
                    {view ? (
                      <Icon
                        label={`${t('design.cad.on')} ${layer}`}
                        pressed={view.shown}
                        onClick={() => onToggle(view.index)}
                      >
                        <path d="M9 18h6M10 21h4" />
                        <path
                          d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.6 1 2.5h6c0-.9.2-1.7 1-2.5A6 6 0 0 0 12 3z"
                          fill={view.shown ? '#ffd54f' : 'none'}
                        />
                      </Icon>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1">
                    {view ? (
                      <Icon
                        label={t('design.cad.freeze', { layer })}
                        pressed={view.frozen}
                        onClick={() => onFreeze(view.index)}
                      >
                        {view.frozen ? (
                          <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="#81d4fa" />
                        ) : (
                          <>
                            <circle cx="12" cy="12" r="4" fill="#ffca28" stroke="#ffca28" />
                            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
                          </>
                        )}
                      </Icon>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1">
                    {view ? (
                      <Icon
                        label={t('design.cad.lock', { layer })}
                        pressed={view.locked}
                        onClick={() => onLock(view.index)}
                      >
                        <rect
                          x="5"
                          y="11"
                          width="14"
                          height="9"
                          rx="1"
                          fill={view.locked ? '#ffca28' : 'none'}
                        />
                        <path
                          d={view.locked ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'}
                        />
                      </Icon>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1">
                    {view ? (
                      <span className="flex items-center gap-1">
                        <span
                          aria-hidden="true"
                          className="inline-block size-3.5 shrink-0 border border-white/40"
                          style={{ backgroundColor: view.color }}
                        />
                        <select
                          aria-label={t('design.cad.layerColor', { layer })}
                          className={`min-h-7 w-24 rounded ${DARK_FIELD}`}
                          value={ACI_COLORS.some((c) => c.hex === view.color) ? view.color : ''}
                          onChange={(event) => onColor(view.index, event.target.value || null)}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <option value="">—</option>
                          {ACI_COLORS.map((c) => (
                            <option key={c.aci} value={c.hex}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </span>
                    ) : null}
                  </td>
                  {edit ? (
                    <td className="px-1.5 py-1">
                      <Meaning edit={edit} layer={layer} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {listed.length === 0 ? (
            <p className="p-2 text-xs">{t('design.viewer.noLayers')}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-between gap-2 border-t border-[#454b55] px-3 py-1.5 text-[11px] text-[#aab0b8]">
          <span>
            {t('design.cad.manager.count', {
              shown: ltr(listed.length),
              total: ltr(all.length),
            })}
          </span>
          <span dir="auto">{t('design.cad.screenLayers')}</span>
        </div>
      </div>
    </div>
  );
}

/** What the layer means for the build: its rule, a mapped layer it was made like, or nothing. */
function Meaning({ edit, layer }: { edit: CanvasEditState; layer: string }) {
  const { t } = useI18n();
  const meaning = edit.meaningOf(layer);
  if (meaning.kind === 'rule') {
    return <span className="text-[#aab0b8]">{t('design.cad.manager.byMapping')}</span>;
  }
  const value = meaning.kind === 'like' ? meaning.like : DRAWING_ONLY;
  return (
    <select
      aria-label={t('design.cad.manager.meaningOf', { layer })}
      title={t('design.cad.manager.meaningHint')}
      className={`min-h-7 w-56 rounded ${DARK_FIELD}`}
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        if (event.target.value !== DRAWING_ONLY) edit.setMeaning(layer, event.target.value);
      }}
    >
      <option value={DRAWING_ONLY} disabled={meaning.kind === 'like'}>
        {t('design.cad.manager.drawingOnly')}
      </option>
      {edit.layers
        .filter((name) => name !== layer)
        .map((name) => (
          <option key={name} value={name}>
            {t('design.cad.manager.like', { layer: name })}
          </option>
        ))}
    </select>
  );
}

function LayerForm({
  edit,
  form,
  picked,
  name,
  setName,
  like,
  setLike,
  message,
  onDone,
  onCancel,
}: {
  edit: CanvasEditState;
  form: 'new' | 'rename' | 'delete';
  picked: string | null;
  name: string;
  setName: (value: string) => void;
  like: string;
  setLike: (value: string) => void;
  message: string | null;
  onDone: (error: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const field = `min-h-8 rounded px-2 text-xs ${DARK_FIELD}`;
  return (
    <div
      role="group"
      aria-label={t(`design.cad.layerDialog.${form === 'new' ? 'add' : form}`)}
      className="mx-2 mt-2 flex flex-wrap items-end gap-2 rounded border border-[#4a505a] bg-[#22262c] p-2 text-xs"
    >
      {form === 'delete' ? (
        <>
          <p className="basis-full" dir="auto">
            <strong>{picked}</strong> — {t('design.cad.layerDeleteWarn')}
          </p>
          <button
            type="button"
            className="min-h-8 rounded bg-[#b3261e] px-3 text-white"
            onClick={() => {
              if (picked) edit.deleteLayer(picked);
              onDone(null);
            }}
          >
            {t('design.cad.layerDeleteConfirm')}
          </button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            {form === 'new' ? t('design.cad.layerName') : t('design.cad.layerNewName')}
            <input
              className={field}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {form === 'new' ? (
            <label className="flex flex-col gap-1">
              {t('design.cad.manager.meaning')}
              <select
                className={field}
                value={like}
                onChange={(event) => setLike(event.target.value)}
              >
                <option value={NONE}>{t('design.fix.chooseLayer')}</option>
                <option value={DRAWING_ONLY}>{t('design.cad.manager.drawingOnly')}</option>
                {edit.layers.map((layer) => (
                  <option key={layer} value={layer}>
                    {t('design.cad.manager.like', { layer })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="min-h-8 rounded bg-[#3d6fb6] px-3 text-white"
            onClick={() => {
              if (form === 'rename') {
                onDone(edit.renameLayer(picked ?? '', name));
                return;
              }
              if (like === NONE) {
                onDone('design.cad.layerNameMissing');
                return;
              }
              onDone(edit.addLayer(name, like === DRAWING_ONLY ? null : like));
            }}
          >
            {form === 'new' ? t('design.cad.layerAddConfirm') : t('design.cad.layerRenameConfirm')}
          </button>
        </>
      )}
      <button type="button" className="min-h-8 rounded px-3 hover:bg-white/10" onClick={onCancel}>
        {t('design.edit.cancel')}
      </button>
      {message ? (
        <p role="alert" className="basis-full text-[#ff8a80]" dir="auto">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-1.5 py-1 text-start font-normal">{children}</th>;
}

function BarButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-8 min-w-8 items-center justify-center rounded hover:bg-white/10 disabled:opacity-40"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

function Icon({
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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex min-h-8 min-w-8 items-center justify-center rounded hover:bg-white/10"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}
