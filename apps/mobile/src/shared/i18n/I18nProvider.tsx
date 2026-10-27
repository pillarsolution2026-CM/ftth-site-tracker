import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from '@ftth/i18n';
import { SecureLocaleStorage, type LocaleStorage } from '../storage/locale-storage';
import { applyDirection } from './direction';

interface I18nContextValue {
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => Promise<void>;
  /** True after a direction change until the app is restarted. */
  needsRestart: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const defaultStorage = new SecureLocaleStorage();

export function I18nProvider({
  children,
  storage = defaultStorage,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  storage?: LocaleStorage;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    let active = true;
    void storage.read().then((stored) => {
      if (!active) return;
      const next = stored ?? initialLocale;
      setLocaleState(next);
      setNeedsRestart(applyDirection(next));
    });
    return () => {
      active = false;
    };
  }, [storage, initialLocale]);

  const setLocale = useCallback(
    async (next: Locale) => {
      setLocaleState(next);
      setNeedsRestart(applyDirection(next));
      await storage.write(next);
    },
    [storage],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      needsRestart,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale, needsRestart],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
