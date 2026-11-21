import { OfflineBundleSchema, type OfflineBundle, type OfflineDrawing } from '@ftth/shared';
import type { Vault } from '../../../shared/crypto/vault';
import type { DrawingChoice } from './drawing-picker';

/** Text files in the app's private storage; the bundle is stored sealed (ADR-025). */
export interface TextFiles {
  readText(name: string): Promise<string | null>;
  writeText(name: string, text: string): Promise<void>;
}

/**
 * One file per user, project and drawing (ADR-049 part B): another user's sites are never
 * shown from the cache, and a drawing downloaded once opens offline. Without a drawing id the
 * file is the one written before drawings existed (the General published last).
 */
const fileName = (userId: string, projectId: string, drawingId: string | null) =>
  drawingId === null
    ? `bundle-${userId}-${projectId}.json`
    : `bundle-${userId}-${projectId}-${drawingId}.json`;

/** A cached bundle; invalid or missing files read as null. */
export async function loadCachedBundle(
  files: TextFiles,
  vault: Vault,
  userId: string,
  projectId: string,
  drawingId: string | null = null,
): Promise<OfflineBundle | null> {
  try {
    const sealed = await files.readText(fileName(userId, projectId, drawingId));
    if (sealed === null) return null;
    const parsed = OfflineBundleSchema.safeParse(JSON.parse(await vault.openText(sealed)));
    return parsed.success && parsed.data.project.id === projectId ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Saves a downloaded bundle under the drawing it holds. A bundle fetched without a drawing id
 * is also kept under the old name, so the first start after an update still finds it.
 */
export async function saveBundle(
  files: TextFiles,
  vault: Vault,
  userId: string,
  bundle: OfflineBundle,
  requestedDrawingId: string | null = null,
): Promise<void> {
  const sealed = await vault.sealText(JSON.stringify(bundle));
  const projectId = bundle.project.id;
  const held = bundle.revision?.drawingId ?? requestedDrawingId;
  if (requestedDrawingId === null) await files.writeText(fileName(userId, projectId, null), sealed);
  if (held) await files.writeText(fileName(userId, projectId, held), sealed);
}

/** What the phone knows about drawings: the list, the last choice and what is downloaded. */
export interface DrawingIndex {
  last: DrawingChoice | null;
  /** drawingId → the revision number held on the phone. */
  downloaded: Record<string, number>;
  /** The published drawings as of the last download (needed to pick while offline). */
  drawings: OfflineDrawing[];
}

export const EMPTY_INDEX: DrawingIndex = { last: null, downloaded: {}, drawings: [] };

const indexName = (userId: string, projectId: string) => `drawings-${userId}-${projectId}.json`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLast(value: unknown): DrawingChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { siteId, drawingId } = value as Record<string, unknown>;
  if (typeof drawingId !== 'string' || !UUID.test(drawingId)) return null;
  if (siteId !== null && !(typeof siteId === 'string' && UUID.test(siteId))) return null;
  return { siteId: siteId as string | null, drawingId };
}

export async function loadDrawingIndex(
  files: TextFiles,
  userId: string,
  projectId: string,
): Promise<DrawingIndex> {
  try {
    const text = await files.readText(indexName(userId, projectId));
    if (text === null) return EMPTY_INDEX;
    const raw = JSON.parse(text) as Record<string, unknown>;
    const drawings = OfflineBundleSchema.shape.drawings.safeParse(raw.drawings);
    const downloaded: Record<string, number> = {};
    if (typeof raw.downloaded === 'object' && raw.downloaded !== null) {
      for (const [id, revNo] of Object.entries(raw.downloaded)) {
        if (typeof revNo === 'number' && Number.isInteger(revNo) && revNo >= 1) {
          downloaded[id] = revNo;
        }
      }
    }
    return {
      last: parseLast(raw.last),
      downloaded,
      drawings: drawings.success ? drawings.data : [],
    };
  } catch {
    return EMPTY_INDEX;
  }
}

export async function saveDrawingIndex(
  files: TextFiles,
  userId: string,
  projectId: string,
  index: DrawingIndex,
): Promise<void> {
  await files.writeText(indexName(userId, projectId), JSON.stringify(index));
}

/** The index after a bundle was downloaded: the new list, and this drawing's revision noted. */
export function withDownloadedBundle(index: DrawingIndex, bundle: OfflineBundle): DrawingIndex {
  const drawingId = bundle.revision?.drawingId;
  return {
    ...index,
    drawings: bundle.drawings,
    downloaded:
      drawingId && bundle.revision
        ? { ...index.downloaded, [drawingId]: bundle.revision.revNo }
        : index.downloaded,
  };
}
