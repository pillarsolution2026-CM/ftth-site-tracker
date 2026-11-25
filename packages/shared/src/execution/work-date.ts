/**
 * ADR-057 (owner, 2026-11-25): every work update carries a work date — the calendar day the work
 * was done, chosen by the supervisor (today or any earlier day, never later). The day is read in
 * Egypt's time zone. The contractor price follows this day (ADR-053).
 */
export const WORK_DAY_TIME_ZONE = 'Africa/Cairo';

function makeDayFormat(): Intl.DateTimeFormat | null {
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: WORK_DAY_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // An engine without time-zone data may ignore the zone: check one known instant (UTC+2).
    return intlDay(format, new Date('2026-01-01T22:30:00Z')) === '2026-01-02' ? format : null;
  } catch {
    return null;
  }
}

function intlDay(format: Intl.DateTimeFormat, instant: Date): string {
  const parts = format.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const HOUR_MS = 3_600_000;

/** Day of the month of the last `weekday` (0 = Sunday) of a month (0-based), in `year`. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

/**
 * Egypt's rule without Intl time-zone data (some phone JavaScript engines): UTC+2, and UTC+3 in
 * summer time (since 2023), from the last Friday of April at 00:00 to the end of the last Thursday
 * of October. Used only when Intl cannot read Africa/Cairo.
 */
export function cairoDayByRule(instant: Date): string {
  const year = instant.getUTCFullYear();
  const start = Date.UTC(year, 3, lastWeekday(year, 3, 5)) - 2 * HOUR_MS;
  const end = Date.UTC(year, 9, lastWeekday(year, 9, 4) + 1) - 3 * HOUR_MS;
  const t = instant.getTime();
  const summer = year >= 2023 && t >= start && t < end;
  return new Date(t + (summer ? 3 : 2) * HOUR_MS).toISOString().slice(0, 10);
}

const dayFormat = makeDayFormat();

/** The calendar day (YYYY-MM-DD) of an instant, read in Africa/Cairo. */
export function workDayOf(instant: Date): string {
  return dayFormat ? intlDay(dayFormat, instant) : cairoDayByRule(instant);
}

/** The day before / after `day` (YYYY-MM-DD), on the calendar alone (no time zone involved). */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}
