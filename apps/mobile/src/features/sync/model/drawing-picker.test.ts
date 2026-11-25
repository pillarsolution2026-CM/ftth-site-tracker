import type { OfflineBundle, OfflineDrawing } from '@ftth/shared';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import {
  EMPTY_INDEX,
  loadCachedBundle,
  loadDrawingIndex,
  pruneRemovedDrawings,
  saveBundle,
  saveDrawingIndex,
  withDownloadedBundle,
  type TextFiles,
} from './bundle-cache';
import {
  defaultDrawingOfSite,
  drawingsToDownload,
  groupBySite,
  pickInitialDrawing,
} from './drawing-picker';

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
    elementGroups: [],
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

describe('drawings taken away (ADR-054)', () => {
  it('deletes the sealed bundle and forgets the drawing when it is no longer listed', async () => {
    const files = new MemoryFiles();
    const vault = createVault(async () => new Uint8Array(32).fill(7), testRandom);
    await saveBundle(files, vault, USER, bundleOf(A_GEN, [A_GEN, B_GEN]), A_GEN.drawingId);
    await saveBundle(files, vault, USER, bundleOf(B_GEN, [A_GEN, B_GEN]), B_GEN.drawingId);
    const held = { [A_GEN.drawingId]: 1, [B_GEN.drawingId]: 1 };
    // The site of B_GEN was taken away: the next bootstrap lists A_GEN only.
    const fresh = bundleOf(A_GEN, [A_GEN]);
    await pruneRemovedDrawings(files, USER, PROJECT, held, fresh);
    expect(await loadCachedBundle(files, vault, USER, PROJECT, B_GEN.drawingId)).toBeNull();
    expect(await loadCachedBundle(files, vault, USER, PROJECT, A_GEN.drawingId)).not.toBeNull();
    const index = withDownloadedBundle(
      { ...EMPTY_INDEX, downloaded: held, last: { siteId: SITE_B, drawingId: B_GEN.drawingId } },
      fresh,
    );
    expect(Object.keys(index.downloaded)).toEqual([A_GEN.drawingId]);
    expect(index.last).toBeNull();
  });

  it('uses deleteText when the device offers it', async () => {
    const files = new MemoryFiles();
    const deleted: string[] = [];
    const withDelete: TextFiles = {
      readText: (n) => files.readText(n),
      writeText: (n, t) => files.writeText(n, t),
      deleteText: async (n) => void deleted.push(n),
    };
    await pruneRemovedDrawings(
      withDelete,
      USER,
      PROJECT,
      { [B_GEN.drawingId]: 1 },
      bundleOf(A_GEN, [A_GEN]),
    );
    expect(deleted).toEqual([`bundle-${USER}-${PROJECT}-${B_GEN.drawingId}.json`]);
  });
});

describe('drawingsToDownload', () => {
  it('lists drawings that are missing or older on the phone, General first', () => {
    const newer = { ...A_SEC1, revision: { ...A_SEC1.revision, revNo: 3 } };
    const todo = drawingsToDownload([NO_SITE, A_SEC2, B_GEN, newer, A_GEN], {
      [A_GEN.drawingId]: 1, // current
      [newer.drawingId]: 2, // outdated
      [A_SEC2.drawingId]: 5, // the phone is already ahead of the list: leave it
    });
    expect(todo.map((d) => d.drawingId)).toEqual([
      newer.drawingId,
      B_GEN.drawingId,
      NO_SITE.drawingId,
    ]);
  });

  it('is empty when everything is up to date or nothing is published', () => {
    expect(drawingsToDownload([], {})).toEqual([]);
    expect(drawingsToDownload([A_GEN], { [A_GEN.drawingId]: 1 })).toEqual([]);
  });
});
