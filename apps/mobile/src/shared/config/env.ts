/** Base URL of the API. 10.0.2.2 is the host machine as seen from the Android emulator. */
export const API_URL: string = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3001').replace(
  /\/+$/,
  '',
);
