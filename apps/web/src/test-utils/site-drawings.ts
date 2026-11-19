import type { SiteDrawing, SiteDrawingsResponse } from '@ftth/shared';

export const SITE_A = '3a000000-0000-4000-8000-00000000000a';
export const SITE_B = '3b000000-0000-4000-8000-00000000000b';

const id = (n: number) => `4d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A drawing of a site, never published and with no open revision unless overridden. */
export function drawing(n: number, overrides: Partial<SiteDrawing> = {}): SiteDrawing {
  return {
    id: id(n),
    siteId: SITE_A,
    siteName: 'Site A',
    kind: 'general',
    ordinal: 1,
    currentFileId: `5f000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    currentFileName: `file-${n}.dxf`,
    openRevision: null,
    latestPublished: null,
    withdrawnAt: null,
    ...overrides,
  };
}

export function published(revNo: number, n = 1): NonNullable<SiteDrawing['latestPublished']> {
  return {
    id: `6e000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    revNo,
    publishedAt: '2026-11-01T10:00:00.000Z',
  };
}

export function draftRevision(n: number): NonNullable<SiteDrawing['openRevision']> {
  return { id: `7c000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'draft' };
}

/** Site A (General + Secondary 1 and 2) and Site B (empty), plus unassigned drawings. */
export function siteDrawings(overrides: Partial<SiteDrawingsResponse> = {}): SiteDrawingsResponse {
  return {
    sites: [
      {
        siteId: SITE_A,
        name: 'Site A',
        drawings: [
          drawing(1, { latestPublished: published(2, 1) }),
          drawing(2, { kind: 'secondary', ordinal: 1, openRevision: draftRevision(2) }),
          drawing(3, { kind: 'secondary', ordinal: 2 }),
        ],
      },
      { siteId: SITE_B, name: 'Site B', drawings: [] },
    ],
    unassigned: [],
    ...overrides,
  };
}
