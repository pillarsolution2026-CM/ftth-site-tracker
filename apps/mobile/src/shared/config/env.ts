/** Base URL of the API. 10.0.2.2 is the host machine as seen from the Android emulator. */
export const API_URL: string = requireHttpsOutsideDev(
  (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3001').replace(/\/+$/, ''),
  typeof __DEV__ === 'boolean' ? __DEV__ : true,
);

/** Tokens, photos and GPS fixes never travel in clear text from a release build. */
export function requireHttpsOutsideDev(url: string, dev: boolean): string {
  if (!dev && !url.startsWith('https://')) {
    throw new Error('EXPO_PUBLIC_API_URL must use https in release builds');
  }
  return url;
}
