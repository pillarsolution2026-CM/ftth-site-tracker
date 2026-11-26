import { describe, expect, it } from 'vitest';
import { cairoDayByRule, shiftDay, workDayOf } from './work-date.js';

describe('workDayOf (ADR-057, Africa/Cairo)', () => {
  it('reads the day in Cairo, not in UTC', () => {
    // 23:30 UTC on the 10th is already the 11th in Cairo (UTC+2 in November).
    expect(workDayOf(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11');
    expect(workDayOf(new Date('2026-11-10T21:30:00Z'))).toBe('2026-11-10');
  });

  it('keeps 1 a.m. Cairo on the new day', () => {
    expect(workDayOf(new Date('2026-11-11T01:00:00+02:00'))).toBe('2026-11-11');
  });
});

describe('cairoDayByRule (phones without Intl time zones)', () => {
  it('matches Intl for every hour of 2024 to 2027, summer time included', () => {
    const misses: string[] = [];
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2028, 0, 1); t += 3_600_000) {
      const instant = new Date(t);
      if (cairoDayByRule(instant) !== workDayOf(instant)) misses.push(instant.toISOString());
    }
    expect(misses).toEqual([]);
  });
});

describe('shiftDay', () => {
  it('moves across month and year ends', () => {
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
  });
});
