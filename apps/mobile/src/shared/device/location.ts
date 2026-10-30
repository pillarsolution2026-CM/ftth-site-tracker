import * as Location from 'expo-location';
import type { GpsFix } from '@ftth/shared';

/** One GPS fix, or null when permission is refused or no fix arrives in time (weak GPS). */
export async function currentGpsFix(timeoutMs = 15_000): Promise<GpsFix | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') return null;
  const position = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]).catch(() => null);
  if (!position) return null;
  return {
    lon: position.coords.longitude,
    lat: position.coords.latitude,
    accuracyM: position.coords.accuracy ?? null,
    at: new Date(position.timestamp).toISOString(),
  };
}
