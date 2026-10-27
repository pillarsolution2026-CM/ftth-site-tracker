'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { directionOf, translate, type Locale, type MessageKey } from '@ftth/i18n';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: directionOf(locale),
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <LocaleProvider>');
  return value;
}
