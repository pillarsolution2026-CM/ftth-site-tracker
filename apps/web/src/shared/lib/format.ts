import type { Locale } from '@ftth/i18n';

const TAGS: Record<Locale, string> = { ar: 'ar-EG-u-nu-latn', en: 'en-GB', fr: 'fr-FR' };

/** 1536 → "1.5 KB". Sizes are display only. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** ISO timestamp → local date and time with Latin digits in every locale. */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

/** Plain count/measure for display (drawing units, counts); not for money. */
export function formatNumber(value: number, locale: Locale, maximumFractionDigits = 3): string {
  return new Intl.NumberFormat(TAGS[locale], { maximumFractionDigits }).format(value);
}
