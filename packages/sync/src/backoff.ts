/** Retry delays for a failed sync (ADR-024): 2 s doubling to a 5 min cap, with full jitter. */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;

/**
 * Delay before retry number `failures` (1 = first retry). `random` is in [0, 1); full jitter keeps
 * many phones that regain network together from hitting the server at the same instant.
 */
export function backoffDelayMs(failures: number, random: number = Math.random()): number {
  if (failures <= 0) return 0;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 30));
  const jittered = Math.floor(ceiling * Math.min(Math.max(random, 0), 0.999_999));
  return Math.max(BACKOFF_BASE_MS / 2, jittered);
}
