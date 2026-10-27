/** Base URL of the FTTH API (server-side only; the browser never talks to it directly). */
export function apiUrl(): string {
  return (process.env.API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}
