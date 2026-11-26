'use client';

import { useState } from 'react';
import { ltr, type MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { CanvasEdit } from '../model/canvas-edit';
import type { DrawingPreview } from '../model/drawing-preview';
import type { DrawingScene } from '../model/drawing-scene';
import {
  nameOf,
  objectTypes,
  propertyEdits,
  propertyRows,
  type PropertyRow,
  type PropertySection,
} from '../model/properties';

const SECTIONS: readonly PropertySection[] = ['general', 'geometry', 'text', 'misc', 'attributes'];

/**
 * AutoCAD's Properties palette (owner 2026-11-26): the type drop-down and the sections of the picked
 * objects. A changed cell is saved as an unsaved edit (it goes with «حفظ»); a read-only cell says
 * why in its tooltip.
 */
export function PropertiesPalette({
  scene,
  preview,
  chosen,
  layers,
  editing,
  onApply,
}: {
  scene: DrawingScene;
  preview: DrawingPreview;
  chosen: ReadonlySet<number>;
  /** Layers objects may move to (they have a rule). */
  layers: readonly string[];
  editing: boolean;
  onApply: (edits: CanvasEdit[]) => void;
}) {
  const { t } = useI18n();
  // One object per handle (an INSERT's shapes share one).
  const seen = new Set<string>();
  const all: number[] = [];
  for (const index of chosen) {
    const handle = scene.view.entities[index]?.handle;
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    all.push(index);
  }
  const key = all.join(',');
  const [filter, setFilter] = useState<{ key: string; type: string }>({ key, type: '' });
  const [vertex, setVertex] = useState<{ key: string; at: number }>({ key, at: 0 });
  const [refused, setRefused] = useState(false);
  const type = filter.key === key ? filter.type : '';
  const types = objectTypes(scene, preview, all);
  const indexes = type ? all.filter((i) => nameOf(scene, preview, i) === type) : all;
  const input = {
    scene,
    preview,
    indexes,
    layers,
    vertex: vertex.key === key ? vertex.at : 0,
  };
  const rows = propertyRows(input);
  const commit = (row: PropertyRow, value: string) => {
    if (row.id === 'vertex') {
      setVertex({ key, at: Number(value) });
      return;
    }
    if (value === row.raw) return;
    const made = propertyEdits(input, row.id, value);
    setRefused(made === null);
    if (made && made.length > 0) onApply(made);
  };
  const single = types.length === 1 && types[0]?.count === 1;
  return (
    <div className="flex flex-col gap-2 text-sm" dir="ltr">
      <select
        aria-label={t('design.cad.prop.type')}
        value={type}
        disabled={all.length === 0}
        onChange={(event) => setFilter({ key, type: event.target.value })}
        className="min-h-8 rounded border border-(--color-border) bg-transparent px-1"
      >
        {all.length === 0 ? (
          <option value="">{t('design.cad.prop.noSelection')}</option>
        ) : single ? (
          <option value="">{types[0]?.name}</option>
        ) : (
          <>
            <option value="">{t('design.cad.prop.all', { count: ltr(all.length) })}</option>
            {types.map((item) => (
              <option key={item.name} value={item.name}>
                {`${item.name} (${item.count})`}
              </option>
            ))}
          </>
        )}
      </select>
      {!editing && all.length > 0 ? (
        <p className="text-xs opacity-80" dir="auto">
          {t('design.cad.prop.editFirst')}
        </p>
      ) : null}
      {refused ? (
        <p role="status" className="text-xs text-(--color-error,#b71c1c)" dir="auto">
          {t('design.cad.prop.refused')}
        </p>
      ) : null}
      {SECTIONS.map((section) => {
        const inSection = rows.filter((row) => row.section === section);
        if (inSection.length === 0) return null;
        const title = t(`design.cad.prop.section.${section}` as MessageKey);
        return (
          <table key={section} aria-label={title} className="w-full border-collapse text-xs">
            <caption className="bg-black/10 px-1 py-0.5 text-start font-semibold">{title}</caption>
            <tbody>
              {inSection.map((row) => (
                <Row
                  key={`${key}|${type}|${input.vertex}|${row.id}|${row.raw ?? ''}`}
                  row={row}
                  label={t(`design.cad.prop.${row.label}` as MessageKey)}
                  reason={row.reason ? t(`design.cad.prop.why.${row.reason}` as MessageKey) : null}
                  editing={editing}
                  onCommit={(value) => commit(row, value)}
                />
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

function Row({
  row,
  label,
  reason,
  editing,
  onCommit,
}: {
  row: PropertyRow;
  label: string;
  reason: string | null;
  editing: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(row.raw ?? '');
  const { editor } = row;
  const canEdit = editor !== null && (editing || row.id === 'vertex');
  let cell;
  if (canEdit && editor.kind === 'select') {
    cell = (
      <select
        aria-label={label}
        value={row.raw ?? ''}
        onChange={(event) => onCommit(event.target.value)}
        className="min-h-7 w-full rounded border border-(--color-border) bg-transparent px-1"
      >
        {row.raw === undefined ? <option value="">{row.value}</option> : null}
        {editor.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (canEdit) {
    cell = (
      <input
        aria-label={label}
        value={draft}
        inputMode={editor.kind === 'number' ? 'decimal' : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit(draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(row.raw ?? '');
          }
        }}
        className="min-h-7 w-full rounded border border-(--color-border) bg-transparent px-1 font-mono"
      />
    );
  } else {
    cell = (
      <span
        aria-label={label}
        aria-readonly="true"
        title={reason ?? undefined}
        className="block truncate px-1 font-mono opacity-70"
      >
        {row.value}
      </span>
    );
  }
  return (
    <tr className="border-b border-(--color-border)">
      <th scope="row" className="w-2/5 px-1 py-0.5 text-start font-normal" title={reason ?? label}>
        {label}
      </th>
      <td className="py-0.5">{cell}</td>
    </tr>
  );
}
