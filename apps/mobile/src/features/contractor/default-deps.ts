import { deviceVault } from '../../shared/crypto/device-key';
import { deleteText, readText, writeText } from '../../shared/device/files';
import { authApi } from '../auth/api/default-api';
import { createPortalCache } from './model/portal-cache';

/** Production wiring: the sealed cache in the app's document directory, the real API. */
export const portalCache = createPortalCache(
  {
    sealText: (plain) => deviceVault().sealText(plain),
    openText: (sealed) => deviceVault().openText(sealed),
  },
  { readText, writeText, deleteText },
);
export const portalApi = authApi;
export const clearPortalCache = () => portalCache.clear();
export const offlineProfile = async () => (await portalCache.read())?.me ?? null;
