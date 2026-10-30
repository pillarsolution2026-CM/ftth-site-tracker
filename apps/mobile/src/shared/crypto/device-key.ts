import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { base64ToBytes, bytesToBase64, createVault, KEY_BYTES, type Vault } from './vault';

const KEY_NAME = 'ftth.data_key.v1';

/**
 * The installation's data key lives only in the OS keystore (Android Keystore / iOS Keychain),
 * readable while the phone is unlocked and never copied to another device or backup. Losing it
 * (app uninstalled) makes the local data unreadable, which is the point.
 */
async function deviceKey(): Promise<Uint8Array> {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const stored = await SecureStore.getItemAsync(KEY_NAME, options);
  if (stored) {
    const key = base64ToBytes(stored);
    if (key.length === KEY_BYTES) return key;
  }
  const created = Crypto.getRandomBytes(KEY_BYTES);
  await SecureStore.setItemAsync(KEY_NAME, bytesToBase64(created), options);
  return created;
}

let vault: Vault | null = null;

export function deviceVault(): Vault {
  vault ??= createVault(deviceKey, (count) => Crypto.getRandomBytes(count));
  return vault;
}
