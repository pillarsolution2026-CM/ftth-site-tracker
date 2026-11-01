import type { AsBuiltEdit, AsBuiltFeatureState, OfflineBundle } from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';
import { buildAsBuiltState, type AsBuiltState } from './asbuilt-state';
import type { EditorContext } from './editor';

/** Shared fixtures of the As-Built tests (not shipped: only imported by *.test files). */
let counter = 0;
export const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

export const PROJECT = '00000000-0000-4000-8000-0000000000a1';
export const USER = '00000000-0000-4000-8000-0000000000e1';
export const OTHER_USER = '00000000-0000-4000-8000-0000000000e2';
export const REVISION = '00000000-0000-4000-8000-0000000000a2';
export const BOX = '00000000-0000-4000-8000-0000000000b1';
export const HHI = '00000000-0000-4000-8000-0000000000b2';
export const ROUTE = '00000000-0000-4000-8000-0000000000b3';
export const E = 330_000;
export const N = 3_340_000;

/** Box at (E, N), handhole at (E+100, N), a 3-vertex route (E,N) → (E+50,N+30) → (E+100,N). */
export const designFeatures: OfflineBundle['features'] = [
  {
    id: BOX,
    type: 'box',
    code: '1-1',
    layer: 'sub',
    geometry: { type: 'Point', coordinates: [E, N] },
    lengthM: null,
  },
  {
    id: HHI,
    type: 'hhi',
    code: 'H-2',
    layer: 'sub',
    geometry: { type: 'Point', coordinates: [E + 100, N] },
    lengthM: null,
  },
  {
    id: ROUTE,
    type: 'route',
    code: 'R-1',
    layer: 'duct',
    geometry: {
      type: 'LineString',
      coordinates: [
        [E, N],
        [E + 50, N + 30],
        [E + 100, N],
      ],
    },
    lengthM: '116.619',
  },
];

export function bundleWith(asBuilt: AsBuiltFeatureState[] = []): OfflineBundle {
  return {
    serverTime: '2026-10-30T08:00:00.000Z',
    project: { id: PROJECT, name: 'قليوب', crsEpsg: 32636 },
    scope: { kind: 'zones', zoneIds: ['00000000-0000-4000-8000-0000000000a5'] },
    revision: {
      id: REVISION,
      revNo: 1,
      publishedAt: '2026-10-29T08:00:00.000Z',
      tilesAvailable: true,
    },
    features: designFeatures,
    asBuilt,
    catalog: [],
    settings: {
      gpsWarningDistanceM: 50,
      suggestedQuantity: 'unavailable',
      photoRequirements: { status: 'unavailable', byWorkType: {}, fallback: [] },
    },
  };
}

export function remoteEdit(
  partial: Partial<AsBuiltEdit> & Pick<AsBuiltEdit, 'featureId' | 'kind'>,
): AsBuiltEdit {
  return {
    id: uuid(),
    clientOpId: uuid(),
    featureType: 'box',
    designRevisionId: REVISION,
    baseVersion: 0,
    geometry: null,
    label: null,
    lengthM: null,
    note: null,
    userId: OTHER_USER,
    userName: 'qc',
    deviceId: uuid(),
    capturedAt: '2026-10-30T10:00:00Z',
    receivedAt: '2026-10-30T10:00:01Z',
    flags: [],
    status: 'pending',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedVersion: null,
    ...partial,
  };
}

export function stateOf(
  options: {
    asBuilt?: AsBuiltFeatureState[];
    remote?: AsBuiltEdit[];
    entries?: OutboxEntry[];
  } = {},
): AsBuiltState {
  return buildAsBuiltState({
    bundle: bundleWith(options.asBuilt ?? []),
    remoteEdits: options.remote ?? [],
    entries: options.entries ?? [],
    userId: USER,
  });
}

export function ctxOf(state: AsBuiltState = stateOf()): EditorContext {
  return { state, revisionId: REVISION };
}
