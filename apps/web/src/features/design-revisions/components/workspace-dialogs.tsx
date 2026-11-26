'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { effectiveLayer } from '../model/drawing-preview';
import { TableDialog } from './table-dialog';

/**
 * The workspace's AutoCAD-like dialogs (owner 2026-11-24): FIND (find and replace text, as
 * AutoCAD's Find and Replace), Layer Walk (only the chosen layers on the screen while it is open)
 * and Edit Attributes (the values of a block reference). Replacing saves edits as the other
 * commands do: nothing is kept until «حفظ».
 */

export const FIELD =
  'min-h-8 rounded border border-[#4a505a] bg-[#1d2127] px-2 text-xs text-[#e8eaed]';
export const BUTTON =
  'min-h-8 rounded border border-[#5a606a] px-3 text-xs text-[#e8eaed] hover:bg-white/10 disabled:opacity-40';

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      dir="ltr"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      className="absolute left-1/2 top-12 z-40 flex max-h-[80%] w-[28rem] max-w-[95%] -translate-x-1/2 flex-col rounded border border-[#4a505a] bg-[#2b2f36] text-[#e8eaed] shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-[#4a505a] px-3 py-1.5">
        <span className="text-sm font-semibold">{title}</span>
        <button
          type="button"
          aria-label={t('design.cad.dialogClose', { name: title })}
          onClick={onClose}
          className="min-h-8 min-w-8 rounded hover:bg-white/10"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

/** One text place on the drawing: a text, or a value shown on a block reference. */
interface Found {
  index: number;
  /** The value as shown now (corrections in force and unsaved edits applied). */
  text: string;
  kind: string;
  layer: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function FindDialog({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { scene, edit } = viewer;
  const preview = edit.preview;
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [at, setAt] = useState<number | null>(null);

  const pattern = useMemo(() => {
    if (!find) return null;
    const body = whole ? `\\b${escape(find)}\\b` : escape(find);
    return new RegExp(body, matchCase ? 'g' : 'gi');
  }, [find, matchCase, whole]);

  const results = useMemo<Found[]>(() => {
    if (!scene || !preview || !pattern) return [];
    const out: Found[] = [];
    scene.view.entities.forEach((entity, index) => {
      if (preview.erased.has(index) || entity.texts.length === 0) return;
      const layer = scene.view.layers[effectiveLayer(scene, preview, index)]?.name ?? '';
      entity.texts.forEach((text, i) => {
        const shown =
          i === 0 && preview.textOf.has(index)
            ? (preview.textOf.get(index) ?? text.text)
            : (preview.attrOf.get(index)?.get(text.text) ?? text.text);
        pattern.lastIndex = 0;
        if (pattern.test(shown)) out.push({ index, text: shown, kind: entity.kind, layer });
      });
    });
    return out;
  }, [scene, preview, pattern]);

  const replaced = (text: string) => (pattern ? text.replace(pattern, replace) : text);
  const canReplace = edit.editing && find !== '' && replace !== find;
  const current = at !== null ? results[at] : undefined;
  const show = (i: number) => {
    const item = results[i];
    if (!item) return;
    setAt(i);
    viewer.zoomToEntity(item.index);
  };
  const replaceOne = (item: Found) => {
    const to = replaced(item.text);
    if (to.trim() && to !== item.text) edit.replaceText(item.index, item.text, to);
  };

  return (
    <Dialog title={t('design.cad.find.title')} onClose={() => viewer.setDialog(null)}>
      <label className="flex flex-col gap-1 text-xs">
        {t('design.cad.find.what')}
        <input
          value={find}
          onChange={(event) => {
            setFind(event.target.value);
            setAt(null);
          }}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t('design.cad.find.with')}
        <input
          value={replace}
          onChange={(event) => setReplace(event.target.value)}
          className={FIELD}
        />
      </label>
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(event) => setMatchCase(event.target.checked)}
          />
          {t('design.cad.find.matchCase')}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={whole}
            onChange={(event) => setWhole(event.target.checked)}
          />
          {t('design.cad.find.wholeWords')}
        </label>
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={BUTTON}
          disabled={results.length === 0}
          onClick={() => show(at === null ? 0 : (at + 1) % results.length)}
        >
          {t('design.cad.find.next')}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={!canReplace || !current}
          onClick={() => {
            if (current) replaceOne(current);
          }}
        >
          {t('design.cad.find.replace')}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={!canReplace || results.length === 0}
          onClick={() => {
            for (const item of results) replaceOne(item);
            setAt(null);
          }}
        >
          {t('design.cad.find.replaceAll')}
        </button>
      </div>
      <p role="status" className="text-xs opacity-80">
        {find ? t('design.cad.find.count', { count: results.length }) : t('design.cad.find.hint')}
        {!edit.editing && find ? ` ${t('design.cad.find.penToReplace')}` : ''}
      </p>
      {results.length > 0 ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-start opacity-70">
              <th className="text-start font-normal">{t('design.cad.find.context')}</th>
              <th className="text-start font-normal">{t('design.cad.find.type')}</th>
              <th className="text-start font-normal">{t('design.cad.find.layer')}</th>
            </tr>
          </thead>
          <tbody>
            {results.slice(0, 200).map((item, i) => (
              <tr
                key={`${item.index}-${i}`}
                aria-selected={i === at}
                className={i === at ? 'bg-[#3d6fb6]' : 'hover:bg-white/10'}
              >
                <td>
                  <button
                    type="button"
                    onClick={() => show(i)}
                    className="w-full truncate py-1 text-start"
                    dir="auto"
                  >
                    {item.text}
                  </button>
                </td>
                <td>{item.kind}</td>
                <td className="truncate">{item.layer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Dialog>
  );
}

export function LayerWalkDialog({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const close = () => {
    if (chosen.size > 0) viewer.layerScreen.unisolate();
    viewer.setDialog(null);
  };
  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setChosen(next);
    if (next.size > 0) viewer.layerScreen.isolate([...next]);
    else viewer.layerScreen.unisolate();
  };
  return (
    <Dialog
      title={t('design.cad.layerWalk.title', { count: viewer.layerRows.length })}
      onClose={close}
    >
      <p className="text-xs opacity-80">{t('design.cad.layerWalk.hint')}</p>
      <ul aria-label={t('design.cad.layerWalk.title', { count: viewer.layerRows.length })}>
        {viewer.layerRows.map((row) => (
          <li key={row.index}>
            <button
              type="button"
              aria-pressed={chosen.has(row.index)}
              onClick={() => toggle(row.index)}
              className={`flex min-h-8 w-full items-center gap-2 px-2 text-start text-xs ${
                chosen.has(row.index) ? 'bg-[#3d6fb6]' : 'hover:bg-white/10'
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block size-3 border border-white/40"
                style={{ backgroundColor: row.color }}
              />
              {row.name}
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" className={BUTTON} onClick={close}>
          {t('design.cad.layerWalk.close')}
        </button>
      </div>
    </Dialog>
  );
}

export function AttributesDialog({ viewer, index }: { viewer: DrawingViewer; index: number }) {
  const { t } = useI18n();
  const { scene, edit } = viewer;
  const entity = scene?.view.entities[index];
  const shownValue = (text: string) => edit.preview?.attrOf.get(index)?.get(text) ?? text;
  const values = (entity?.texts ?? []).map((text) => shownValue(text.text));
  const [draft, setDraft] = useState<string[]>(values);
  if (!entity) return null;
  return (
    <Dialog
      title={t('design.cad.attributes.title', { handle: entity.handle })}
      onClose={() => viewer.setDialog(null)}
    >
      {values.length === 0 ? (
        <p className="text-xs">{t('design.cad.attributes.none')}</p>
      ) : (
        values.map((value, i) => (
          <label key={i} className="flex flex-col gap-1 text-xs">
            {t('design.cad.attributes.value', { n: i + 1 })}
            <input
              value={draft[i] ?? value}
              dir="auto"
              disabled={!edit.editing}
              onChange={(event) => {
                const next = [...draft];
                next[i] = event.target.value;
                setDraft(next);
              }}
              className={FIELD}
            />
          </label>
        ))
      )}
      {!edit.editing ? (
        <p className="text-xs opacity-80">{t('design.cad.find.penToReplace')}</p>
      ) : null}
      <div className="flex gap-1">
        <button
          type="button"
          className={BUTTON}
          disabled={!edit.editing || values.length === 0}
          onClick={() => {
            values.forEach((value, i) => {
              const to = (draft[i] ?? value).trim();
              if (to && to !== value) edit.setAttribute(index, value, to);
            });
            viewer.setDialog(null);
          }}
        >
          {t('design.cad.attributes.apply')}
        </button>
        <button type="button" className={BUTTON} onClick={() => viewer.setDialog(null)}>
          {t('design.cad.attributes.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

/** The dialog the workspace has open, over the canvas. */
export function WorkspaceDialogs({ viewer }: { viewer: DrawingViewer }) {
  const { dialog } = viewer;
  if (!dialog) return null;
  if (dialog.kind === 'find') return <FindDialog viewer={viewer} />;
  if (dialog.kind === 'laywalk') return <LayerWalkDialog viewer={viewer} />;
  if (dialog.kind === 'table') return <TableDialog viewer={viewer} />;
  return <AttributesDialog key={dialog.index} viewer={viewer} index={dialog.index} />;
}
