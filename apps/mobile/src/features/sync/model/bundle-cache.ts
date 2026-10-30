import { OfflineBundleSchema, type OfflineBundle } from '@ftth/shared';

export interface JsonFiles {
  readJson(name: string): Promise<unknown>;
  writeJson(name: string, value: unknown): Promise<void>;
}

/** One file per user and project: another user's zones are never shown from the cache. */
const fileName = (userId: string, projectId: string) => `bundle-${userId}-${projectId}.json`;

/** The last downloaded offline bundle per project; invalid or missing files read as null. */
export async function loadCachedBundle(
  files: JsonFiles,
  userId: string,
  projectId: string,
): Promise<OfflineBundle | null> {
  try {
    const parsed = OfflineBundleSchema.safeParse(await files.readJson(fileName(userId, projectId)));
    return parsed.success && parsed.data.project.id === projectId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveBundle(files: JsonFiles, userId: string, bundle: OfflineBundle): Promise<void> {
  return files.writeJson(fileName(userId, bundle.project.id), bundle);
}
