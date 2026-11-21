import type { PortalLine, PortalWork, UpdateStatus } from '@ftth/shared';

export type StatusFilter = 'all' | UpdateStatus;
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'pending', 'approved', 'rejected'];

/** Work filtered by status, newest first (the server already sorts; this keeps it stable). */
export function visibleWork(work: readonly PortalWork[], filter: StatusFilter): PortalWork[] {
  const kept = filter === 'all' ? [...work] : work.filter((item) => item.status === filter);
  return kept.sort((a, b) => (a.workDate < b.workDate ? 1 : a.workDate > b.workDate ? -1 : 0));
}

/** His price in force today: the prices come oldest first, the last one is current. */
export function currentPrice(line: PortalLine): string {
  return line.prices[line.prices.length - 1]?.unitPrice ?? '0';
}

/** "2026-11-21 14:05" in the phone's time zone, digits and dashes only (always shown LTR). */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`
  );
}
