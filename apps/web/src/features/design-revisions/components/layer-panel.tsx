'use client';

import { memo } from 'react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { LayerRow } from '../hooks/use-drawing-viewer';

/** Layers of the drawing: colour swatch, on/off, search and all on / all off for the listed ones. */
export const LayerPanel = memo(function LayerPanel({
  rows,
  query,
  onQuery,
  onToggle,
  onSetListed,
}: {
  rows: readonly LayerRow[];
  query: string;
  onQuery: (value: string) => void;
  onToggle: (index: number) => void;
  onSetListed: (shown: boolean) => void;
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
      {listed.length === 0 ? <p className="text-sm">{t('design.viewer.noLayers')}</p> : null}
      <ul className="max-h-[40vh] overflow-y-auto">
        {listed.map((row) => (
          <li key={row.index}>
            <label className="flex min-h-11 items-center gap-2 text-sm">
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
              <Ltr className="break-all">{row.name}</Ltr>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
});
