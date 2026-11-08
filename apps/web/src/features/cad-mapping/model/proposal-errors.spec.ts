import { describe, expect, it } from 'vitest';
import { proposalErrorKey, proposalNeedsReload } from './proposal-errors';

describe('proposalErrorKey', () => {
  it('maps each known 409 reason to its own message', () => {
    expect(proposalErrorKey('CONFLICT', 'VERSION_MISMATCH')).toBe(
      'mapping.proposals.error.VERSION_MISMATCH',
    );
    expect(proposalErrorKey('CONFLICT', 'ALREADY_DECIDED')).toBe(
      'mapping.proposals.error.ALREADY_DECIDED',
    );
    expect(proposalErrorKey('CONFLICT', 'TOO_MANY_POINTS')).toBe(
      'mapping.proposals.error.TOO_MANY_POINTS',
    );
  });

  it('falls back to the generic message for unknown reasons and other codes', () => {
    expect(proposalErrorKey('CONFLICT', 'SOMETHING')).toBe('errors.CONFLICT');
    expect(proposalErrorKey('CONFLICT', null)).toBe('errors.CONFLICT');
    expect(proposalErrorKey('NETWORK', null)).toBe('errors.NETWORK');
  });

  it('offers a reload only for a version mismatch', () => {
    expect(proposalNeedsReload('CONFLICT', 'VERSION_MISMATCH')).toBe(true);
    expect(proposalNeedsReload('CONFLICT', 'ALREADY_DECIDED')).toBe(false);
  });
});
