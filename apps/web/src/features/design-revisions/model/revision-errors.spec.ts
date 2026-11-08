import { translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { publishBlockedMessage, publishBlockedOf } from './revision-errors';

describe('publish refusal messages', () => {
  it.each([
    [{ reason: 'CRS_UNKNOWN' }, /coordinate system .* never chosen/],
    [{ reason: 'PLACEMENT_MISSING' }, /no control point in use/],
    [{ reason: 'PROBLEMS_OPEN', problemCount: 7 }, /7.* drawing errors are left/],
    [{ reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 0 }, /not acknowledged/],
  ] as const)('has a clear message for %j', (details, expected) => {
    const { key, params } = publishBlockedMessage(details);
    expect(translate('en', key, params)).toMatch(expected);
    expect(translate('ar', key, params)).not.toBe(key);
    expect(translate('fr', key, params)).not.toBe(key);
  });

  it('reads the reason out of a 409', () => {
    const error = new ApiClientError('CONFLICT', 409, {
      reason: 'PROBLEMS_OPEN',
      problemCount: 3,
    });
    expect(publishBlockedOf(error)).toEqual({ reason: 'PROBLEMS_OPEN', problemCount: 3 });
    expect(publishBlockedOf(new Error('x'))).toBeNull();
  });
});
