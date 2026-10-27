import { describe, expect, it } from 'vitest';
import { directionOf, ltr, messages, translate } from './index.js';

function keysOf(node: unknown, prefix = ''): string[] {
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`),
  );
}

describe('i18n', () => {
  it('has the same keys in every locale', () => {
    const arKeys = keysOf(messages.ar).sort();
    expect(keysOf(messages.en).sort()).toEqual(arKeys);
    expect(keysOf(messages.fr).sort()).toEqual(arKeys);
  });

  it('fills placeholders', () => {
    expect(translate('en', 'auth.welcome', { name: 'Mona' })).toBe('Welcome, Mona');
  });

  it('is RTL for Arabic only', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('fr')).toBe('ltr');
  });

  it('isolates LTR values', () => {
    expect(ltr('F 36 C')).toBe('⁦F 36 C⁩');
  });
});
