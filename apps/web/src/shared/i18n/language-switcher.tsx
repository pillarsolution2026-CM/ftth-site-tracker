'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LOCALES, type Locale } from '@ftth/i18n';
import { useI18n } from './locale-provider';
import { pathForLocale } from './paths';

/** Each language is named in itself so it is recognisable whatever the current UI language. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  ar: 'العربية',
  en: 'English',
  fr: 'Français',
};

export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const pathname = usePathname();

  return (
    <nav aria-label={t('common.language')} className="flex items-center gap-1">
      {LOCALES.map((target) => {
        const active = target === locale;
        return (
          <Link
            key={target}
            href={pathForLocale(pathname, target)}
            lang={target}
            hrefLang={target}
            aria-current={active ? 'true' : undefined}
            className={
              'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm ' +
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ' +
              (active
                ? 'bg-(--color-brand) font-semibold text-(--color-brandContrast)'
                : 'text-(--color-brand) underline')
            }
          >
            {LANGUAGE_NAMES[target]}
          </Link>
        );
      })}
    </nav>
  );
}
