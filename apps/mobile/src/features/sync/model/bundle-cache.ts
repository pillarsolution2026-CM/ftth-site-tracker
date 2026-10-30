import { OfflineBundleSchema, type OfflineBundle } from '@ftth/shared';

export interface JsonFiles {
  readJson(name: string): Promise<unknown>;
  writeJson(name: string, value: unknown): Promise<void>;
}

const fileName = (projectId: string) => `bundle-${projectId}.json`;

/** The last downloaded offline bundle per project; invalid or missing files read as null. */
export async function loadCachedBundle(
  files: JsonFiles,
  projectId: string,
): Promise<OfflineBundle | null> {
  try {
    const parsed = OfflineBundleSchema.safeParse(await files.readJson(fileName(projectId)));
    return parsed.success && parsed.data.project.id === projectId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveBundle(files: JsonFiles, bundle: OfflineBundle): Promise<void> {
  return files.writeJson(fileName(bundle.project.id), bundle);
}
