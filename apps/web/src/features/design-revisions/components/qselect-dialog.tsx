'use client';

import { useMemo, useState } from 'react';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { ACI_COLORS, LINETYPE_NAMES } from '../model/cad-commands';
import { effectiveLayer, type DrawingPreview } from '../model/drawing-preview';
import type { DrawingScene } from '../model/drawing-scene';
import { nameOf } from '../model/properties';
import { BUTTON, Dialog, FIELD } from './workspace-dialogs';

/**
 * AutoCAD's Quick Select (QSELECT, round 3): Apply to, Object type, Properties, Operator, Value,
 * How to apply and Append to current selection set. The properties are those this screen knows of
 * every object: Color, Layer, Linetype, Lineweight (a field the view of the file does not carry,
 * such as text height or block name of older views, is not offered).
 */

export type QuickProperty = 'color' | 'layer' | 'linetype' | 'lineweight';
export type QuickOperator = '=' | '<>' | 'all';
export const MULTIPLE = 'Multiple';

export interface QuickQuery {
  /** The objects looked at: the whole drawing (every shown, unlocked object) or the picked ones. */
  within: readonly number[];
  type: string;
  property: QuickProperty;
  operator: QuickOperator;
  value: string;
  /** Exclude: the objects that do NOT match. */
  exclude: boolean;
}

const BY_LAYER = 'ByLayer';

/** An object's value of a property, as the Properties palette shows it. */
export function quickValue(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
  property: QuickProperty,
): string {
  const style = preview.styleOf.get(index);
  switch (property) {
    case 'layer':
      return scene.view.layers[effectiveLayer(scene, preview, index)]?.name ?? '';
    case 'color': {
      const hex = style?.color ?? scene.view.entities[index]?.color ?? null;
      return hex === null ? BY_LAYER : (ACI_COLORS.find((c) => c.hex === hex)?.name ?? hex);
    }
    case 'linetype':
      return style?.linetype ? LINETYPE_NAMES[style.linetype] : BY_LAYER;
    case 'lineweight':
      return style?.lineweight !== null && style?.lineweight !== undefined
        ? `${style.lineweight.toFixed(2)} mm`
        : BY_LAYER;
  }
}

/** The objects QSELECT picks. */
export function quickSelect(
  scene: DrawingScene,
  preview: DrawingPreview,
  query: QuickQuery,
): number[] {
  return query.within.filter((index) => {
    const typed = query.type === MULTIPLE || nameOf(scene, preview, index) === query.type;
    if (!typed) return false;
    const value = quickValue(scene, preview, index, query.property);
    const match =
      query.operator === 'all'
        ? true
        : query.operator === '='
          ? value === query.value
          : value !== query.value;
    return query.exclude ? !match : match;
  });
}

export function QSelectDialog({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { scene, edit } = viewer;
  const preview = edit.preview;
  const picked = edit.chosen;
  const [applyTo, setApplyTo] = useState<'all' | 'picked'>(picked.size > 0 ? 'picked' : 'all');
  const [type, setType] = useState(MULTIPLE);
  const [property, setProperty] = useState<QuickProperty>('layer');
  const [operator, setOperator] = useState<QuickOperator>('=');
  const [value, setValue] = useState('');
  const [exclude, setExclude] = useState(false);
  const [append, setAppend] = useState(false);

  const within = useMemo(() => {
    if (!scene || !preview) return [];
    if (applyTo === 'picked') return [...picked];
    return edit.selectable();
  }, [scene, preview, applyTo, picked, edit]);
  const types = useMemo(() => {
    if (!scene || !preview) return [];
    return [...new Set(within.map((i) => nameOf(scene, preview, i)))].sort();
  }, [scene, preview, within]);
  const values = useMemo(() => {
    if (!scene || !preview) return [];
    const typed = within.filter((i) => type === MULTIPLE || nameOf(scene, preview, i) === type);
    return [...new Set(typed.map((i) => quickValue(scene, preview, i, property)))].sort();
  }, [scene, preview, within, type, property]);
  const shownValue = values.includes(value) ? value : (values[0] ?? '');
  const close = () => viewer.setDialog(null);

  if (!scene || !preview) return null;
  const label = 'flex flex-col gap-1 text-xs';
  return (
    <Dialog title={t('design.cad.qselect_title')} onClose={close}>
      <label className={label}>
        {t('design.cad.qselect_applyTo')}
        <select
          className={FIELD}
          value={applyTo}
          onChange={(event) => setApplyTo(event.target.value as 'all' | 'picked')}
        >
          <option value="all">{t('design.cad.qselect_entire')}</option>
          <option value="picked" disabled={picked.size === 0}>
            {t('design.cad.qselect_current')}
          </option>
        </select>
      </label>
      <label className={label}>
        {t('design.cad.qselect_objectType')}
        <select className={FIELD} value={type} onChange={(event) => setType(event.target.value)}>
          <option value={MULTIPLE}>{MULTIPLE}</option>
          {types.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t('design.cad.qselect_properties')}
        <select
          className={FIELD}
          value={property}
          onChange={(event) => setProperty(event.target.value as QuickProperty)}
        >
          {(['color', 'layer', 'linetype', 'lineweight'] as const).map((p) => (
            <option key={p} value={p}>
              {t(`design.cad.qselect_prop_${p}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t('design.cad.qselect_operator')}
        <select
          className={FIELD}
          value={operator}
          onChange={(event) => setOperator(event.target.value as QuickOperator)}
        >
          <option value="=">= Equals</option>
          <option value="<>">&lt;&gt; Not Equal</option>
          <option value="all">* Select All</option>
        </select>
      </label>
      <label className={label}>
        {t('design.cad.qselect_value')}
        <select
          className={FIELD}
          value={shownValue}
          disabled={operator === 'all'}
          onChange={(event) => setValue(event.target.value)}
        >
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-1 text-xs">
        <legend>{t('design.cad.qselect_howTo')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!exclude} onChange={() => setExclude(false)} />
          {t('design.cad.qselect_include')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={exclude} onChange={() => setExclude(true)} />
          {t('design.cad.qselect_exclude')}
        </label>
      </fieldset>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
        {t('design.cad.qselect_append')}
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            const found = quickSelect(scene, preview, {
              within,
              type,
              property,
              operator,
              value: shownValue,
              exclude,
            });
            edit.selectIndexes(found, append);
            close();
          }}
        >
          {t('design.cad.qselect_ok')}
        </button>
        <button type="button" className={BUTTON} onClick={close}>
          {t('design.cad.qselect_cancel')}
        </button>
      </div>
    </Dialog>
  );
}
