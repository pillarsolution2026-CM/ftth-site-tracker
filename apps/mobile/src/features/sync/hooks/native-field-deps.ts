import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../../../shared/config/env';
import { deviceVault } from '../../../shared/crypto/device-key';
import { readFileBytes, readText, writeText } from '../../../shared/device/files';
import { authApi } from '../../auth/api/default-api';
import { nativeDatabase } from '../db/native-database';
import type { FieldDeps } from './FieldProvider';

const DEVICE_ID_KEY = 'ftth.device_id';

async function deviceId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (stored) return stored;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
  return created;
}

let deps: FieldDeps | null = null;

/** Production wiring of the field screens: SQLite, files, secure store, NetInfo, AppState. */
export function nativeFieldDeps(): FieldDeps {
  deps ??= {
    db: nativeDatabase(),
    baseUrl: API_URL,
    files: { readText, writeText },
    readFileBytes,
    vault: deviceVault(),
    accessToken: () => authApi.accessToken(),
    refreshSession: () => authApi.refreshSession(),
    deviceId,
    onOnline: (callback) => {
      let wasOnline = true;
      return NetInfo.addEventListener((state) => {
        const online = state.isConnected === true && state.isInternetReachable !== false;
        if (online && !wasOnline) callback();
        wasOnline = online;
      });
    },
    onForeground: (callback) => {
      const subscription = AppState.addEventListener('change', (status) => {
        if (status === 'active') callback();
      });
      return () => subscription.remove();
    },
  };
  return deps;
}
