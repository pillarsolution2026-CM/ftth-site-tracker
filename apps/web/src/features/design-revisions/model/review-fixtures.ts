import type { TextLink } from '@ftth/shared';

/** Test data. */
export function link(overrides: Partial<TextLink> = {}): TextLink {
  return {
    id: '3f8fad5b-d9cb-469f-a165-70867728950e',
    revisionId: '4f8fad5b-d9cb-469f-a165-70867728950e',
    textHandle: '2B1',
    layer: 'TXT',
    text: 'F 36 C',
    rawText: 'F 36 C',
    readable: true,
    kind: 'cable',
    status: 'review',
    featureId: '5f8fad5b-d9cb-469f-a165-70867728950e',
    featureType: 'route',
    featureCode: null,
    distanceM: '2.5',
    confidence: '0.612',
    position: { x: 1, y: 2 },
    reviewedById: null,
    reviewedAt: null,
    ...overrides,
  };
}
