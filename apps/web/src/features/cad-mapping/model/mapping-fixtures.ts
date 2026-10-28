import type { CadMappingView, CrsDetection } from '@ftth/shared';

/** Test data: a processed drawing in the Qalyub situation (file says inches, extents say metres). */
export const CAD_FILE_ID = '2f8fad5b-d9cb-469f-a165-70867728950e';

export function detection(overrides: Partial<CrsDetection> = {}): CrsDetection {
  return {
    kind: 'projected_utm',
    reason: 'MATCHES_PROJECT_CRS',
    suggestedEpsg: 32636,
    projectEpsg: 32636,
    impliedUnit: 'm',
    insUnits: 1,
    declaredUnit: 'in',
    unitsConflict: true,
    ...overrides,
  };
}

export function mappingView(overrides: Partial<CadMappingView> = {}): CadMappingView {
  return {
    cadFileId: CAD_FILE_ID,
    fileStatus: 'processed',
    projectEpsg: 32636,
    insUnits: 1,
    crsDetection: detection(),
    layers: [
      {
        name: 'N_DUC_CBL',
        aciColor: 1,
        trueColor: null,
        isOn: true,
        entityCounts: { LWPOLYLINE: 12 },
        entityTotal: 12,
        suggestedTarget: 'route',
        suggestionSource: 'name_pattern',
      },
      {
        name: 'BUILDINGS',
        aciColor: 8,
        trueColor: null,
        isOn: true,
        entityCounts: { LINE: 40 },
        entityTotal: 40,
        suggestedTarget: 'background',
        suggestionSource: 'default',
      },
    ],
    blocks: [
      { name: 'HHI-BLOCK', count: 5, layers: ['RRR'], suggestedTarget: 'hhi' },
      { name: 'TREE', count: 9, layers: ['BUILDINGS'], suggestedTarget: null },
    ],
    texts: [
      { layer: 'RRR', text: 'NEW-HHI', count: 4, suggestedTarget: 'hhi' },
      { layer: 'RRR', text: 'NOTE', count: 2, suggestedTarget: null },
    ],
    mapping: null,
    ...overrides,
  };
}
