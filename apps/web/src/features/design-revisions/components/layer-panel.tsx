'use client';

import { memo, useState, type ReactNode } from 'react';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { MessageKey } from '@ftth/i18n';
import type { CanvasEditState } from '../hooks/use-canvas-edit';
import type { LayerRow } from '../hooks/use-drawing-viewer';
import { ACI_COLORS } from '../model/cad-commands';

/**
 * Layers of the drawing, as AutoCAD's Layer Properties palette (ADR-051): on / off, freeze, lock
 * and colour (for this screen only), search and all on / all off for the listed ones; in the edit
 * mode also the current layer and new / rename / delete (saved as corrections).
 */
export const LayerPanel = memo(function LayerPanel({
  rows,
  query,
  onQuery,
  onToggle,
  onSetListed,
  onFreeze,
  onLock,
  onColor,
  current,
  onMakeCurrent,
  manage,
}: {
  rows: readonly LayerRow[];
  query: string;
  onQuery: (value: string) => void;
  onToggle: (index: number) => void;
  onSetListed: (shown: boolean) => void;
  onFreeze?: (index: number) => void;
  onLock?: (index: number) => void;
  onColor?: (index: number, color: string | null) => void;
  /** The current layer (edit mode). */
  current?: string;
  onMakeCurrent?: (name: string) => void;
  /** New / rename / delete (edit mode). */
  manage?: ReactNode;
}) {
  const { t } = useI18n();
  const needle = query.trim().toLowerCase();
  const listed =
    needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  return (
    <section aria-labelledby="layers-title" className="flex min-h-0 flex-col gap-2">
      <h3 id="layers-title" className="text-base font-semibold">
        {t('design.viewer.layers')} <Ltr>({rows.length})</Ltr>
      </h3>
      <Input
        id="layer-search"
        label={t('design.viewer.layerSearch')}
        type="search"
        dir="ltr"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11 px-3 text-sm"
          onClick={() => onSetListed(true)}
        >
          {t('design.viewer.allOn')}
        </Button>
        <Button
          variant="outline"
          className="min-h-11 px-3 text-sm"
          onClick={() => onSetListed(false)}
        >
          {t('design.viewer.allOff')}
        </Button>
      </div>
      {manage}
      {onFreeze ? <p className="text-xs opacity-80">{t('design.cad.screenLayers')}</p> : null}
      {listed.length === 0 ? <p className="text-sm">{t('design.viewer.noLayers')}</p> : null}
      <ul className="max-h-[48vh] overflow-y-auto">
        {listed.map((row) => (
          <li key={row.index} className="flex items-center gap-1">
            <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5 shrink-0"
                checked={row.shown}
                onChange={() => onToggle(row.index)}
              />
              <span
                aria-hidden="true"
                className="inline-block size-4 shrink-0 rounded-sm border border-(--color-border)"
                style={{ backgroundColor: row.color }}
              />
              <Ltr className={`break-all ${current === row.name ? 'font-bold' : ''}`}>
                {row.name}
              </Ltr>
            </label>
            {onMakeCurrent ? (
              <SmallToggle
                label={t('design.cad.makeCurrent', { layer: row.name })}
                pressed={current === row.name}
                onClick={() => onMakeCurrent(row.name)}
              >
                ✓
              </SmallToggle>
            ) : null}
            {onFreeze ? (
              <SmallToggle
                label={t('design.cad.freeze', { layer: row.name })}
                pressed={row.frozen}
                onClick={() => onFreeze(row.index)}
              >
                {row.frozen ? '❄' : '☀'}
              </SmallToggle>
            ) : null}
            {onLock ? (
              <SmallToggle
                label={t('design.cad.lock', { layer: row.name })}
                pressed={row.locked}
                onClick={() => onLock(row.index)}
              >
                {row.locked ? '🔒' : '🔓'}
              </SmallToggle>
            ) : null}
            {onColor ? (
              <select
                aria-label={t('design.cad.layerColor', { layer: row.name })}
                className="min-h-9 w-20 rounded border border-(--color-border) bg-(--color-surface) text-xs"
                value={ACI_COLORS.some((c) => c.hex === row.color) ? row.color : ''}
                onChange={(event) => onColor(row.index, event.target.value || null)}
              >
                <option value="">—</option>
                {ACI_COLORS.map((c) => (
                  <option key={c.aci} value={c.hex}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
});

function SmallToggle({
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
      className={`min-h-9 min-w-9 rounded border text-sm ${
        pressed ? 'border-(--color-brand) bg-(--color-brand)/15' : 'border-(--color-border)'
      }`}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

type LayerDialog = 'add' | 'rename' | 'delete' | null;

/** New layer (like a mapped one), rename and delete: saved as corrections (ADR-050). */
export function LayerManage({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<LayerDialog>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const open = (next: LayerDialog) => {
    setDialog(dialog === next ? null : next);
    setName('');
    setSource('');
    setMessage(null);
  };
  const done = (error: string | null) => {
    if (error) setMessage(error);
    else setDialog(null);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('add')}>
          + {t('design.cad.layerAdd')}
        </Button>
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('rename')}>
          {t('design.cad.layerRename')}
        </Button>
        <Button variant="outline" className="px-2 text-xs" onClick={() => open('delete')}>
          {t('design.cad.layerDelete')}
        </Button>
      </div>
      {dialog !== null ? (
        <div
          role="dialog"
          aria-label={t(`design.cad.layerDialog.${dialog}`)}
          className="flex flex-col gap-2 rounded-md border border-(--color-border) p-2"
        >
          <p className="text-sm font-semibold">{t(`design.cad.layerDialog.${dialog}`)}</p>
          {dialog === 'add' ? (
            <>
              <Input
                id="cad-layer-name"
                label={t('design.cad.layerName')}
                dir="ltr"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Select
                id="cad-layer-like"
                label={t('design.cad.layerLike')}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t('design.fix.chooseLayer')}</option>
                {edit.layers.map((layer) => (
                  <option key={layer} value={layer}>
                    {layer}
                  </option>
                ))}
              </Select>
              <Button onClick={() => done(edit.addLayer(name, source))}>
                {t('design.cad.layerAddConfirm')}
              </Button>
            </>
          ) : (
            <>
              <Select
                id="cad-layer-source"
                label={t('design.cad.layerPick')}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t('design.fix.chooseLayer')}</option>
                {edit.allLayers.map((layer) => (
                  <option key={layer} value={layer}>
                    {layer}
                  </option>
                ))}
              </Select>
              {dialog === 'rename' ? (
                <>
                  <Input
                    id="cad-layer-new-name"
                    label={t('design.cad.layerNewName')}
                    dir="ltr"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Button onClick={() => done(edit.renameLayer(source, name))}>
                    {t('design.cad.layerRenameConfirm')}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm">{t('design.cad.layerDeleteWarn')}</p>
                  <Button
                    disabled={source === ''}
                    onClick={() => {
                      edit.deleteLayer(source);
                      setDialog(null);
                    }}
                  >
                    {t('design.cad.layerDeleteConfirm')}
                  </Button>
                </>
              )}
            </>
          )}
          {message ? <Notice kind="error">{t(message as MessageKey)}</Notice> : null}
        </div>
      ) : null}
    </div>
  );
}
