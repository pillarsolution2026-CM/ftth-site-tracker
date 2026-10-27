import { describe, expect, it } from 'vitest';
import { pathForLocale } from './paths';

describe('pathForLocale', () => {
  it('swaps the locale prefix', () => {
    expect(pathForLocale('/ar/login', 'fr')).toBe('/fr/login');
    expect(pathForLocale('/en', 'ar')).toBe('/ar');
  });

  it('adds a prefix when missing', () => {
    expect(pathForLocale('/', 'en')).toBe('/en');
    expect(pathForLocale('/login', 'en')).toBe('/en/login');
  });
});
