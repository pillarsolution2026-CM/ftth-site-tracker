import { translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import { mappingErrorKey, needsReload } from './mapping-errors';

describe('mapping errors', () => {
  it('maps NOT_CURRENT_VERSION (building from a superseded file) to a clear message', () => {
    const key = mappingErrorKey('CONFLICT', 'NOT_CURRENT_VERSION');
    expect(key).toBe('mapping.error.NOT_CURRENT_VERSION');
    expect(translate('en', key)).toMatch(/old version/);
    expect(translate('ar', key)).toMatch(/نسخة قديمة/);
    expect(translate('fr', key)).toMatch(/ancienne version/);
    expect(needsReload('CONFLICT', 'NOT_CURRENT_VERSION')).toBe(false);
  });

  it('keeps the generic message for unknown reasons', () => {
    expect(mappingErrorKey('CONFLICT', 'SOMETHING')).toBe('errors.CONFLICT');
  });

  it.each(['ROLE_NOT_FOR_KIND', 'ZONE_NOT_FOR_KIND'] as const)(
    'maps a 422 %s (ADR-041) to its own message in every language',
    (reason) => {
      const key = mappingErrorKey('VALIDATION_FAILED', reason);
      expect(key).toBe(`mapping.error.${reason}`);
      for (const locale of ['ar', 'en', 'fr'] as const) {
        expect(translate(locale, key)).not.toBe(key);
      }
      expect(needsReload('VALIDATION_FAILED', reason)).toBe(false);
    },
  );

  it('keeps the generic message for other 422s', () => {
    expect(mappingErrorKey('VALIDATION_FAILED', 'SOMETHING')).toBe('errors.VALIDATION_FAILED');
  });
});
