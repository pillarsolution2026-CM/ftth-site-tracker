import type { AsBuiltEdit, AsBuiltEditDetail } from '@ftth/shared';

/** Test data for the As-Built review screens (valid against the shared schemas). */
export const EDIT_ID = '2f8fad5b-d9cb-469f-a165-70867728950e';
const FEATURE_ID = '3f8fad5b-d9cb-469f-a165-70867728950e';
const REVISION_ID = '4f8fad5b-d9cb-469f-a165-70867728950e';
const USER_ID = '5f8fad5b-d9cb-469f-a165-70867728950e';

export function makeEdit(overrides: Partial<AsBuiltEdit> = {}): AsBuiltEdit {
  return {
    id: EDIT_ID,
    clientOpId: '6f8fad5b-d9cb-469f-a165-70867728950e',
    featureId: FEATURE_ID,
    kind: 'reshape',
    featureType: 'route',
    designRevisionId: REVISION_ID,
    baseVersion: 0,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [60, 10],
        [120, 0],
      ],
    },
    label: null,
    lengthM: '122.066',
    note: 'The duct bends around the new pole',
    userId: USER_ID,
    userName: 'Hassan Ali',
    deviceId: '7f8fad5b-d9cb-469f-a165-70867728950e',
    capturedAt: '2026-05-02T08:00:00.000+00:00',
    receivedAt: '2026-05-02T08:05:00.000+00:00',
    flags: [],
    status: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedVersion: null,
    ...overrides,
  };
}

export function makeDetail(
  edit: Partial<AsBuiltEdit> = {},
  overrides: Partial<AsBuiltEditDetail> = {},
): AsBuiltEditDetail {
  return {
    edit: makeEdit(edit),
    crsEpsg: 32636,
    design: {
      revisionId: REVISION_ID,
      code: 'R-014',
      layer: 'ROUTE-MAIN',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [120, 0],
        ],
      },
      lengthM: '120.000',
    },
    current: null,
    approvable: true,
    ...overrides,
  };
}
