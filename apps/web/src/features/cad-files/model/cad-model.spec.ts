import type { CadLayer } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { toQueryString } from '../api/cad-api';
import { isCadFileName, isInFlight } from './cad-status';
import { EMPTY_LAYER_FILTER, entityCountEntries, filterLayers } from './layer-filter';

function layer(name: string, overrides: Partial<CadLayer> = {}): CadLayer {
  return {
    id: '1f8fad5b-d9cb-469f-a165-70867728950e',
    name,
    aciColor: 7,
    trueColor: null,
    linetype: null,
    isOn: true,
    isFrozen: false,
    isLocked: false,
    entityCounts: {},
    entityTotal: 0,
    ...overrides,
  };
}

describe('cad status', () => {
  it('polls only while a file is waiting for or inside the worker', () => {
    expect(['uploaded', 'queued', 'processing'].every((s) => isInFlight(s as never))).toBe(true);
    expect(isInFlight('processed')).toBe(false);
    expect(isInFlight('failed')).toBe(false);
  });

  it('accepts only .dwg and .dxf names', () => {
    expect(isCadFileName('Route.DWG')).toBe(true);
    expect(isCadFileName('route.dxf')).toBe(true);
    expect(isCadFileName('route.pdf')).toBe(false);
    expect(isCadFileName('dxf')).toBe(false);
  });
});

describe('layer filter', () => {
  const layers = [
    layer('ROUTE-MAIN', { entityTotal: 5, entityCounts: { LWPOLYLINE: 3, INSERT: 2 } }),
    layer('route-spare', { isOn: false }),
    layer('طبقة-النصوص', { entityTotal: 1 }),
  ];

  it('searches case-insensitively, including Arabic names', () => {
    expect(filterLayers(layers, { ...EMPTY_LAYER_FILTER, search: 'ROUTE' })).toHaveLength(2);
    expect(filterLayers(layers, { ...EMPTY_LAYER_FILTER, search: 'النصوص' })).toHaveLength(1);
  });

  it('combines the flags', () => {
    expect(filterLayers(layers, { ...EMPTY_LAYER_FILTER, withEntitiesOnly: true })).toHaveLength(2);
    expect(
      filterLayers(layers, { ...EMPTY_LAYER_FILTER, onOnly: true, search: 'spare' }),
    ).toHaveLength(0);
  });

  it('lists entity counts biggest first', () => {
    expect(entityCountEntries(layers[0] as CadLayer)).toEqual([
      ['LWPOLYLINE', 3],
      ['INSERT', 2],
    ]);
  });
});

describe('toQueryString', () => {
  it('drops empty values and encodes booleans', () => {
    expect(toQueryString({ page: 2, layer: '', q: undefined, readable: false })).toBe(
      '?page=2&readable=false',
    );
    expect(toQueryString({ layer: 'A B&C' })).toBe('?layer=A+B%26C');
    expect(toQueryString({})).toBe('');
  });
});
