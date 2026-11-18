import type { OfflineBundle, OfflineDrawing } from '@ftth/shared';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import {
  EMPTY_INDEX,
  loadCachedBundle,
  loadDrawingIndex,
  saveBundle,
  saveDrawingIndex,
  withDownloadedBundle,
  type TextFiles,
} from './bundle-cache';
import { defaultDrawingOfSite, groupBySite, pickInitialDrawing } from './drawing-picker';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const USER = id(2);
const SITE_A = id(10);
const SITE_B = id(11);

function drawing(
  n: number,
  siteId: string | null,
  siteName: string | null,
  kind: 'general' | 'secondary',
  ordinal: number,
  revNo = 1,
): OfflineDrawing {
  return {
    drawingId: id(100 + n),
    siteId,
    siteName,
    kind,
    ordinal,
    revision: {
      id: id(200 + n),
      revNo,
      publishedAt: '2026-11-18T08:00:00.000Z',
      tilesAvailable: false,
    },
  };
}

const A_SEC2 = drawing(1, SITE_A, 'Alpha', 'secondary', 2);
const A_SEC1 = drawing(2, SITE_A, 'Alpha', 'secondary', 1);
const A_GEN = drawing(3, SITE_A, 'Alpha', 'general', 1);
const B_GEN = drawing(4, SITE_B, 'Beta', 'general', 1);
const NO_SITE = drawing(5, null, null, 'general', 1);
const ALL = [NO_SITE, A_SEC2, B_GEN, A_SEC1, A_GEN];

function bundleOf(d: OfflineDrawing, all: OfflineDrawing[] = ALL): OfflineBundle {
  return {
    serverTime: '2026-11-18T08:00:00.000Z',
    project: { id: PROJECT, name: 'p', crsEpsg: 32636 },
    scope: { kind: 'project' },
    drawings: all,
    revision: { ...d.revision, drawingId: d.drawingId },
    features: [],
    asBuilt: [],
    catalog: [],
    settings: {
      gpsWarningDistanceM: 50,
      suggestedQuantity: 'unavailable',
      photoRequirements: { status: 'unavailable', byWorkType: {}, fallback: [] },
    },
  } as OfflineBundle;
}

class MemoryFiles implements TextFiles {
  map = new Map<string, string>();
  readText(name: string) {
    return Promise.resolve(this.map.get(name) ?? null);
  }
  writeText(name: string, text: string) {
    this.map.set(name, text);
    return Promise.resolve();
  }
}

describe('drawing picker', () => {
  it('groups by site with General first then Secondary 1..n, unassigned last', () => {
    const groups = groupBySite(ALL);
    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Beta', null]);
    expect(groups[0]?.drawings.map((d) => d.drawingId)).toEqual([
      A_GEN.drawingId,
      A_SEC1.drawingId,
      A_SEC2.drawingId,
    ]);
    expect(groups[2]?.siteId).toBeNull();
  });

  it('opens the remembered drawing, else the first site General', () => {
    expect(pickInitialDrawing(ALL, { siteId: SITE_A, drawingId: A_SEC2.drawingId })).toBe(A_SEC2);
    // The remembered drawing is no longer published.
    expect(pickInitialDrawing([B_GEN, A_GEN], { siteId: SITE_A, drawingId: id(999) })).toBe(A_GEN);
    expect(pickInitialDrawing([], null)).toBeNull();
    expect(pickInitialDrawing([NO_SITE], null)).toBe(NO_SITE);
  });

  it('a site opens with its General', () => {
    const group = groupBySite(ALL)[0];
    expect(group && defaultDrawingOfSite(group)).toBe(A_GEN);
  });
});

describe('per-drawing cache', () => {
  const vault = createVault(async () => testRandom(32), testRandom);

  it('keeps one sealed bundle per drawing so a switch works offline', async () => {
    const files = new MemoryFiles();
    await saveBundle(files, vault, USER, bundleOf(A_GEN), A_GEN.drawingId);
    await saveBundle(files, vault, USER, bundleOf(A_SEC1), A_SEC1.drawingId);
    const gen = await loadCachedBundle(files, vault, USER, PROJECT, A_GEN.drawingId);
    const sec = await loadCachedBundle(files, vault, USER, PROJECT, A_SEC1.drawingId);
    expect(gen?.revision?.id).toBe(A_GEN.revision.id);
    expect(sec?.revision?.id).toBe(A_SEC1.revision.id);
    expect(await loadCachedBundle(files, vault, USER, PROJECT, B_GEN.drawingId)).toBeNull();
    // Nothing went to the old default file when a drawing was asked for.
    expect(await loadCachedBundle(files, vault, USER, PROJECT)).toBeNull();
  });

  it('a download without a drawing id is kept as the default and under its drawing', async () => {
    const files = new MemoryFiles();
    await saveBundle(files, vault, USER, bundleOf(A_GEN));
    expect((await loadCachedBundle(files, vault, USER, PROJECT))?.revision?.drawingId).toBe(
      A_GEN.drawingId,
    );
    expect(await loadCachedBundle(files, vault, USER, PROJECT, A_GEN.drawingId)).not.toBeNull();
  });

  it('remembers the last choice and which drawings are on the phone', async () => {
    const files = new MemoryFiles();
    let index = withDownloadedBundle(EMPTY_INDEX, bundleOf(A_GEN));
    index = withDownloadedBundle(index, bundleOf(A_SEC1));
    index = { ...index, last: { siteId: SITE_A, drawingId: A_SEC1.drawingId } };
    await saveDrawingIndex(files, USER, PROJECT, index);
    const read = await loadDrawingIndex(files, USER, PROJECT);
    expect(read.last).toEqual({ siteId: SITE_A, drawingId: A_SEC1.drawingId });
    expect(read.downloaded).toEqual({ [A_GEN.drawingId]: 1, [A_SEC1.drawingId]: 1 });
    expect(read.drawings).toHaveLength(ALL.length);
  });

  it('reads a damaged or missing index as empty', async () => {
    const files = new MemoryFiles();
    expect(await loadDrawingIndex(files, USER, PROJECT)).toEqual(EMPTY_INDEX);
    files.map.set(`drawings-${USER}-${PROJECT}.json`, '{oops');
    expect(await loadDrawingIndex(files, USER, PROJECT)).toEqual(EMPTY_INDEX);
  });
});
