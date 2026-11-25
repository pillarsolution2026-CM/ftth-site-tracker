/**
 * ADR-057 (owner, 2026-11-25): every work update carries a work date — the calendar day the work
 * was done, chosen by the supervisor (today or any earlier day, never later). The day is read in
 * Egypt's time zone. The contractor price follows this day (ADR-053).
 */
export const WORK_DAY_TIME_ZONE = 'Africa/Cairo';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: WORK_DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar day (YYYY-MM-DD) of an instant, read in Africa/Cairo. */
export function workDayOf(instant: Date): string {
  const parts = dayFormat.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day before / after `day` (YYYY-MM-DD), on the calendar alone (no time zone involved). */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}
