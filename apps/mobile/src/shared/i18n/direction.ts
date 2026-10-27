import { I18nManager } from 'react-native';
import { directionOf, type Locale } from '@ftth/i18n';

/**
 * Applies the layout direction for a locale (Arabic = RTL).
 *
 * `I18nManager.forceRTL` only takes effect after the JS bundle and native layout are reloaded,
 * so switching between ar and en/fr requires an app restart. Returns true when the native
 * direction differs from the wanted one, i.e. a restart is needed.
 */
export function applyDirection(locale: Locale): boolean {
  const wantRtl = directionOf(locale) === 'rtl';
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== wantRtl) {
    I18nManager.forceRTL(wantRtl);
    return true;
  }
  return false;
}
