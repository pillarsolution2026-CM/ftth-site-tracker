import { describe, expect, it } from 'vitest';
import { statusTokens, toCssVariables } from './index.js';

describe('ui tokens', () => {
  it('gives every status an icon and a label, not only a colour', () => {
    for (const token of Object.values(statusTokens)) {
      expect(token.icon).toBeTruthy();
      expect(token.labelKey).toMatch(/^status\./);
    }
  });

  it('emits CSS variables', () => {
    expect(toCssVariables()).toContain('--status-approved:#1E9E5A');
  });
});
