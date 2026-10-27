import * as SecureStore from 'expo-secure-store';
import { isLocale, type Locale } from '@ftth/i18n';

export interface LocaleStorage {
  read(): Promise<Locale | null>;
  write(locale: Locale): Promise<void>;
}

const LOCALE_KEY = 'ftth.locale';

export class SecureLocaleStorage implements LocaleStorage {
  async read(): Promise<Locale | null> {
    const value = await SecureStore.getItemAsync(LOCALE_KEY);
    return isLocale(value) ? value : null;
  }

  async write(locale: Locale): Promise<void> {
    await SecureStore.setItemAsync(LOCALE_KEY, locale);
  }
}

export class InMemoryLocaleStorage implements LocaleStorage {
  private locale: Locale | null;

  constructor(initial: Locale | null = null) {
    this.locale = initial;
  }

  async read(): Promise<Locale | null> {
    return this.locale;
  }

  async write(locale: Locale): Promise<void> {
    this.locale = locale;
  }
}
