import { describe, expect, it } from 'vitest';
import { cadPalette, statusTokens, toCssVariables } from './index.js';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('ui tokens', () => {
  it('gives every status an icon and a label, not only a colour', () => {
    for (const token of Object.values(statusTokens)) {
      expect(token.icon).toBeTruthy();
      expect(token.labelKey).toMatch(/^status\./);
    }
  });

  it('keeps every CAD colour at WCAG AA contrast against its background, day and night', () => {
    for (const palette of Object.values(cadPalette)) {
      for (const [name, color] of Object.entries(palette)) {
        if (name === 'background') continue;
        expect(contrast(color, palette.background), name).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('emits CSS variables', () => {
    expect(toCssVariables()).toContain('--status-approved:#1E9E5A');
  });
});
