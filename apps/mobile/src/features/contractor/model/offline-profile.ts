import type { MeResponse } from '@ftth/shared';
import { base64ToBytes } from '../../../shared/crypto/vault';
import type { PortalCache } from './portal-cache';

/** The `sub` (user id) of a JWT, read without verifying: only a local consistency check. */
export function tokenSubject(token: string | null): string | null {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return null;
    const json = new TextDecoder().decode(
      base64ToBytes(payload.replace(/-/g, '+').replace(/_/g, '/')),
    );
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/**
 * The saved profile for an offline start, only when it is fresh (the cache enforces its age) and
 * belongs to the user of the stored session; anything else is wiped and the user signs in again.
 */
export function createOfflineProfile(
  cache: PortalCache,
  accessToken: () => Promise<string | null>,
) {
  return async (): Promise<MeResponse | null> => {
    const saved = await cache.read();
    if (!saved) return null;
    if (tokenSubject(await accessToken()) !== saved.me.id) {
      await cache.clear();
      return null;
    }
    return saved.me;
  };
}
