import { isLocale, type Locale } from '@ftth/i18n';

/** Rewrites `/ar/foo` to `/en/foo`; paths without a locale prefix get one. */
export function pathForLocale(pathname: string, locale: Locale): string {
  const [, first, ...rest] = pathname.split('/');
  const tail = isLocale(first) ? rest : [first ?? '', ...rest];
  const suffix = tail.filter((part) => part !== '').join('/');
  return suffix ? `/${locale}/${suffix}` : `/${locale}`;
}

export function loginPath(locale: Locale): string {
  return `/${locale}/login`;
}

export function homePath(locale: Locale): string {
  return `/${locale}`;
}
