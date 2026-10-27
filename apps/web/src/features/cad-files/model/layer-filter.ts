import type { CadLayer } from '@ftth/shared';

export interface LayerFilter {
  search: string;
  /** Only layers that contain entities. */
  withEntitiesOnly: boolean;
  /** Only layers that are switched on. */
  onOnly: boolean;
}

export const EMPTY_LAYER_FILTER: LayerFilter = {
  search: '',
  withEntitiesOnly: false,
  onOnly: false,
};

/** Case-insensitive substring match on the layer name (names keep their original spelling). */
export function filterLayers(layers: readonly CadLayer[], filter: LayerFilter): CadLayer[] {
  const needle = filter.search.trim().toLowerCase();
  return layers.filter(
    (layer) =>
      (needle === '' || layer.name.toLowerCase().includes(needle)) &&
      (!filter.withEntitiesOnly || layer.entityTotal > 0) &&
      (!filter.onOnly || layer.isOn),
  );
}

/** "LWPOLYLINE 120, INSERT 17", biggest first. */
export function entityCountEntries(layer: Pick<CadLayer, 'entityCounts'>): [string, number][] {
  return Object.entries(layer.entityCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
