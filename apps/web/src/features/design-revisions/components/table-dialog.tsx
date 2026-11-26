'use client';

import { useState } from 'react';
import type { TableCellStyle } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import {
  cellRects,
  DEFAULT_TABLE_SPEC,
  rowCount,
  specProblem,
  styleOfRow,
  tableAt,
  type TableSpec,
} from '../model/table';
import { BUTTON, Dialog, FIELD } from './workspace-dialogs';

/**
 * AutoCAD's Insert Table dialog (owner 2026-11-26): table style Standard, «Start from empty table»,
 * insertion point or window, columns and column width, data rows and row height (lines), the cell
 * styles of row 1, row 2 and the other rows, and a preview. «From a data link» and «From object
 * data in the drawing (Data Extraction)» need files and objects the web screen does not have: shown
 * greyed with the reason. OK places the table from the command line.
 */

const STYLES: readonly TableCellStyle[] = ['title', 'header', 'data'];
const STYLE_NAME: Record<TableCellStyle, string> = {
  title: 'Title',
  header: 'Header',
  data: 'Data',
};

function NumberField({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span>{label}</span>
      <input
        type="number"
        dir="ltr"
        inputMode="decimal"
        step={step}
        min={min}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`${FIELD} w-24`}
      />
    </label>
  );
}

function StyleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TableCellStyle;
  onChange: (value: TableCellStyle) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as TableCellStyle)}
        className={`${FIELD} w-28`}
      >
        {STYLES.map((style) => (
          <option key={style} value={style}>
            {STYLE_NAME[style]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The dialog's preview: the grid of the table, the title and header rows named. */
function TablePreview({ spec }: { spec: TableSpec }) {
  const { t } = useI18n();
  const shown: TableSpec = {
    ...spec,
    columns: Math.min(Math.max(1, Math.floor(spec.columns) || 1), 12),
    dataRows: Math.min(Math.max(1, Math.floor(spec.dataRows) || 1), 12),
  };
  const table = tableAt({ ...shown, columnWidth: 20 }, [0, 0]);
  const width = table.columns.reduce((s, w) => s + w, 0);
  const height = table.rows.reduce((s, h) => s + h, 0);
  return (
    <svg
      role="img"
      aria-label={t('design.cad.table.preview')}
      viewBox={`-2 -2 ${width + 4} ${height + 4}`}
      className="h-32 w-full rounded border border-[#4a505a] bg-white"
    >
      {cellRects(table).map((cell) => {
        const style = styleOfRow(table.styles, cell.row);
        return (
          <g key={`${cell.row}-${cell.col}`}>
            <rect
              x={cell.x0}
              y={-cell.y0}
              width={cell.x1 - cell.x0}
              height={cell.y0 - cell.y1}
              fill={style === 'data' ? '#ffffff' : '#e8eef8'}
              stroke="#333"
              strokeWidth={0.4}
            />
            {style !== 'data' && cell.col === 0 ? (
              <text
                x={style === 'title' ? width / 2 : cell.x0 + (cell.x1 - cell.x0) / 2}
                y={-cell.y0 + (cell.y0 - cell.y1) / 2 + 2}
                fontSize={5}
                textAnchor="middle"
                fill="#333"
              >
                {STYLE_NAME[style]}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function TableDialog({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const [spec, setSpec] = useState<TableSpec>(DEFAULT_TABLE_SPEC);
  const [preview, setPreview] = useState(true);
  const set = (patch: Partial<TableSpec>) => setSpec((previous) => ({ ...previous, ...patch }));
  const problem = specProblem(spec);
  const close = () => viewer.setDialog(null);
  const noLink = t('design.cad.table.noDataLink');
  return (
    <Dialog title={t('design.cad.table.title')} onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem) return;
          close();
          viewer.edit.placeTable(spec);
        }}
      >
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="font-semibold">{t('design.cad.table.style')}</legend>
          <select className={`${FIELD} w-40`} value="Standard" disabled>
            <option value="Standard">Standard</option>
          </select>
        </fieldset>
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="font-semibold">{t('design.cad.table.insertOptions')}</legend>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked readOnly name="table-from" />
            {t('design.cad.table.fromEmpty')}
          </label>
          <label className="flex items-center gap-1.5 opacity-40" title={noLink}>
            <input type="radio" disabled name="table-from" />
            {t('design.cad.table.fromLink')}
          </label>
          <label className="flex items-center gap-1.5 opacity-40" title={noLink}>
            <input type="radio" disabled name="table-from" />
            {t('design.cad.table.fromData')}
          </label>
        </fieldset>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={preview}
            onChange={(event) => setPreview(event.target.checked)}
          />
          {t('design.cad.table.showPreview')}
        </label>
        {preview ? <TablePreview spec={spec} /> : null}
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="font-semibold">{t('design.cad.table.insertion')}</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="table-insertion"
              checked={spec.insertion === 'point'}
              onChange={() => set({ insertion: 'point' })}
            />
            {t('design.cad.table.byPoint')}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="table-insertion"
              checked={spec.insertion === 'window'}
              onChange={() => set({ insertion: 'window' })}
            />
            {t('design.cad.table.byWindow')}
          </label>
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-x-4 gap-y-1">
          <legend className="text-xs font-semibold">{t('design.cad.table.columnsRows')}</legend>
          <NumberField
            label={t('design.cad.table.columns')}
            value={spec.columns}
            step={1}
            min={1}
            onChange={(columns) => set({ columns })}
          />
          <NumberField
            label={t('design.cad.table.columnWidth')}
            value={spec.columnWidth}
            step={0.5}
            min={0}
            onChange={(columnWidth) => set({ columnWidth })}
          />
          <NumberField
            label={t('design.cad.table.dataRows')}
            value={spec.dataRows}
            step={1}
            min={1}
            onChange={(dataRows) => set({ dataRows })}
          />
          <NumberField
            label={t('design.cad.table.rowHeight')}
            value={spec.rowLines}
            step={1}
            min={1}
            onChange={(rowLines) => set({ rowLines })}
          />
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-semibold">{t('design.cad.table.cellStyles')}</legend>
          {(['first', 'second', 'others'] as const).map((which, i) => (
            <StyleField
              key={which}
              label={t(`design.cad.table.${which}Row`)}
              value={spec.styles[i] ?? 'data'}
              onChange={(style) => {
                const styles = [...spec.styles] as TableSpec['styles'];
                styles[i] = style;
                set({ styles });
              }}
            />
          ))}
        </fieldset>
        <p className="text-xs text-[#aab0b8]" dir="ltr">
          {t('design.cad.table.rowsTotal', { rows: rowCount(spec), columns: spec.columns || 0 })}
        </p>
        {problem ? (
          <p role="alert" className="text-xs text-[#ff8a8a]">
            {t(`design.cad.table.problem.${problem}`)}
          </p>
        ) : null}
        <div className="flex gap-1">
          <button type="submit" className={BUTTON} disabled={problem !== null}>
            OK
          </button>
          <button type="button" className={BUTTON} onClick={close}>
            {t('design.cad.table.cancel')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
