'use client';

import { useState } from 'react';
import type { CadLayer } from '@ftth/shared';
import { Checkbox } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { aciToCss, trueColorToCss } from '@/shared/lib/aci-color';
import { EMPTY_LAYER_FILTER, entityCountEntries, filterLayers } from '../model/layer-filter';

function Flag({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span aria-hidden="true">{on ? '●' : '○'}</span>
      {on ? onLabel : offLabel}
    </span>
  );
}

/** Colour swatch next to the ACI number, so the colour is also given as text. */
export function LayerSwatch({ layer }: { layer: Pick<CadLayer, 'aciColor' | 'trueColor'> }) {
  const css = layer.trueColor !== null ? trueColorToCss(layer.trueColor) : aciToCss(layer.aciColor);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-block size-5 shrink-0 rounded border border-(--color-border)"
        style={{ backgroundColor: css }}
      />
      <Ltr className="text-xs">{layer.trueColor !== null ? css : `ACI ${layer.aciColor}`}</Ltr>
    </span>
  );
}

export function LayersTable({ layers }: { layers: CadLayer[] }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState(EMPTY_LAYER_FILTER);
  const shown = filterLayers(layers, filter);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <Input
          id="layer-search"
          type="search"
          label={t('cad.layers.search')}
          value={filter.search}
          onChange={(event) => setFilter({ ...filter, search: event.target.value })}
        />
        <Checkbox
          id="layer-with-entities"
          label={t('cad.layers.withEntitiesOnly')}
          checked={filter.withEntitiesOnly}
          onChange={(event) => setFilter({ ...filter, withEntitiesOnly: event.target.checked })}
        />
        <Checkbox
          id="layer-on-only"
          label={t('cad.layers.onOnly')}
          checked={filter.onOnly}
          onChange={(event) => setFilter({ ...filter, onOnly: event.target.checked })}
        />
      </div>
      <p aria-live="polite">
        {t('cad.layers.shown', { shown: shown.length, total: layers.length })}
      </p>
      {shown.length === 0 ? (
        <p>{t('cad.layers.none')}</p>
      ) : (
        <Table aria-label={t('cad.tabs.layers')}>
          <thead>
            <tr>
              <Th>{t('cad.layers.color')}</Th>
              <Th>{t('cad.layers.name')}</Th>
              <Th>{t('cad.layers.entities')}</Th>
              <Th>{t('cad.layers.total')}</Th>
              <Th>{t('cad.layers.flags')}</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((layer) => (
              <tr key={layer.id}>
                <Td>
                  <LayerSwatch layer={layer} />
                </Td>
                <Td>
                  <Ltr className="break-all">{layer.name}</Ltr>
                </Td>
                <Td>
                  <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
                    {entityCountEntries(layer).map(([type, count]) => (
                      <li key={type}>
                        <Ltr>
                          {type} {count}
                        </Ltr>
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td>
                  <Ltr>{layer.entityTotal}</Ltr>
                </Td>
                <Td>
                  <div className="flex flex-col gap-1">
                    <Flag
                      on={layer.isOn}
                      onLabel={t('cad.layers.on')}
                      offLabel={t('cad.layers.off')}
                    />
                    {layer.isFrozen ? (
                      <Flag on onLabel={t('cad.layers.frozen')} offLabel="" />
                    ) : null}
                    {layer.isLocked ? (
                      <Flag on onLabel={t('cad.layers.locked')} offLabel="" />
                    ) : null}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
