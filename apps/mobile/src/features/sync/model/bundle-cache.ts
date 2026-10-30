import { OfflineBundleSchema, type OfflineBundle } from '@ftth/shared';
import type { Vault } from '../../../shared/crypto/vault';

/** Text files in the app's private storage; the bundle is stored sealed (ADR-025). */
export interface TextFiles {
  readText(name: string): Promise<string | null>;
  writeText(name: string, text: string): Promise<void>;
}

/** One file per user and project: another user's zones are never shown from the cache. */
const fileName = (userId: string, projectId: string) => `bundle-${userId}-${projectId}.json`;

/** The last downloaded offline bundle per project; invalid or missing files read as null. */
export async function loadCachedBundle(
  files: TextFiles,
  vault: Vault,
  userId: string,
  projectId: string,
): Promise<OfflineBundle | null> {
  try {
    const sealed = await files.readText(fileName(userId, projectId));
    if (sealed === null) return null;
    const parsed = OfflineBundleSchema.safeParse(JSON.parse(await vault.openText(sealed)));
    return parsed.success && parsed.data.project.id === projectId ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveBundle(
  files: TextFiles,
  vault: Vault,
  userId: string,
  bundle: OfflineBundle,
): Promise<void> {
  await files.writeText(
    fileName(userId, bundle.project.id),
    await vault.sealText(JSON.stringify(bundle)),
  );
}
