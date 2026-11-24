import {
  ContractorPortalResponseSchema,
  MeResponseSchema,
  type ContractorPortalResponse,
  type MeResponse,
} from '@ftth/shared';
import type { Vault } from '../../../shared/crypto/vault';

/**
 * The last answer of GET /contractor/me, kept so the contractor can read it offline (ADR-053).
 * It holds prices and quantities, so it is sealed with the device key (ADR-025) and never written
 * as plain JSON. The profile is kept with it so the app can open offline.
 */
export const PORTAL_CACHE_FILE = 'contractor-portal.sealed';

/**
 * TUNABLE: how long a saved answer may be used offline, counted from the server time of that
 * answer. An older snapshot is wiped and never shown (a stopped account must not read forever).
 */
export const PORTAL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PortalSnapshot {
  me: MeResponse;
  portal: ContractorPortalResponse;
}

export interface PortalCache {
  /** Null when nothing is saved, or the file is unreadable or altered. */
  read(): Promise<PortalSnapshot | null>;
  write(snapshot: PortalSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export interface PortalCacheFiles {
  readText(name: string): Promise<string | null>;
  writeText(name: string, text: string): Promise<void>;
  deleteText(name: string): Promise<void>;
}

export function createPortalCache(
  vault: Pick<Vault, 'sealText' | 'openText'>,
  files: PortalCacheFiles,
  now: () => number = Date.now,
): PortalCache {
  return {
    async read() {
      try {
        const sealed = await files.readText(PORTAL_CACHE_FILE);
        if (!sealed) return null;
        const raw = JSON.parse(await vault.openText(sealed)) as { me?: unknown; portal?: unknown };
        const me = MeResponseSchema.safeParse(raw.me);
        const portal = ContractorPortalResponseSchema.safeParse(raw.portal);
        if (!me.success || !portal.success) return null;
        const age = now() - Date.parse(portal.data.serverTime);
        if (!(age <= PORTAL_CACHE_MAX_AGE_MS)) {
          await files.deleteText(PORTAL_CACHE_FILE);
          return null;
        }
        return { me: me.data, portal: portal.data };
      } catch {
        return null;
      }
    },
    async write(snapshot) {
      await files.writeText(PORTAL_CACHE_FILE, await vault.sealText(JSON.stringify(snapshot)));
    },
    async clear() {
      await files.deleteText(PORTAL_CACHE_FILE);
    },
  };
}
