import { translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { publishBlockedMessage, publishBlockedOf } from './revision-errors';

describe('publish refusal messages', () => {
  it.each([
    [{ reason: 'CRS_UNKNOWN', drawingKind: 'general' }, /coordinate system .* never chosen/],
    [{ reason: 'PLACEMENT_MISSING', drawingKind: 'general' }, /no control point in use/],
    [
      { reason: 'PROBLEMS_OPEN', drawingKind: 'general', problemCount: 7 },
      /7.* drawing errors are left/,
    ],
    [{ reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 0 }, /not acknowledged/],
    [{ reason: 'OTHER_DRAWING_MISSING', drawingKind: 'secondary' }, /both drawings are published/],
  ] as const)('has a clear message for %j', (details, expected) => {
    const { key, params } = publishBlockedMessage(details, 'en');
    expect(translate('en', key, params)).toMatch(expected);
    expect(translate('ar', key, params)).not.toBe(key);
    expect(translate('fr', key, params)).not.toBe(key);
  });

  it('names the drawing that blocks, in each language', () => {
    const secondary = publishBlockedMessage(
      { reason: 'OTHER_DRAWING_MISSING', drawingKind: 'secondary' },
      'en',
    );
    expect(translate('en', secondary.key, secondary.params)).toMatch(/no draft for the Secondary/);
    const placement = publishBlockedMessage(
      { reason: 'PLACEMENT_MISSING', drawingKind: 'secondary' },
      'en',
    );
    expect(translate('en', placement.key, placement.params)).toMatch(
      /Secondary drawing has no control point/,
    );
    const arabic = publishBlockedMessage(
      { reason: 'PROBLEMS_OPEN', drawingKind: 'general', problemCount: 2 },
      'ar',
    );
    expect(translate('ar', arabic.key, arabic.params)).toContain('جينيرال (رئيسي)');
  });

  it('reads the reason out of a 409', () => {
    const error = new ApiClientError('CONFLICT', 409, {
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'general',
      problemCount: 3,
    });
    expect(publishBlockedOf(error)).toEqual({
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'general',
      problemCount: 3,
    });
    expect(publishBlockedOf(new Error('x'))).toBeNull();
  });
});
