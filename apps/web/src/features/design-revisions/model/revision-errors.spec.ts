import type { PublishBlockedDetails } from '@ftth/shared';
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

describe('CABINETS_MISMATCH refusal (ADR-041)', () => {
  const details: PublishBlockedDetails = {
    reason: 'CABINETS_MISMATCH',
    cabinets: {
      ok: false,
      general: { count: 9, unnamed: 0, missingInOther: ['1-9'] },
      secondary: { count: 8, unnamed: 1, missingInOther: [] },
    },
  };

  it('names both counts and the cabinets that exist in one drawing only', () => {
    const { key, params } = publishBlockedMessage(details, 'en');
    const text = translate('en', key, params);
    expect(text).toMatch(/General .*9.* \/ Secondary .*8/);
    expect(text).toMatch(/Only in the General: .*1-9/);
    expect(text).toMatch(/Only in the Secondary: —/);
    expect(text).toMatch(/with no name: .*1/);
    expect(translate('ar', key, params)).toMatch(/الكباين مش متطابقة/);
    expect(translate('fr', key, params)).not.toBe(key);
  });

  it('is read out of a 409', () => {
    expect(publishBlockedOf(new ApiClientError('CONFLICT', 409, details))).toEqual(details);
  });
});

describe('INSTALLATION_UNCLEAR refusal (ADR-042)', () => {
  const details: PublishBlockedDetails = {
    reason: 'INSTALLATION_UNCLEAR',
    drawingKind: 'general',
    issueCount: 2,
    issues: [
      {
        code: 'QUESTION_UNANSWERED',
        markIds: [],
        routeHandle: null,
        featureId: null,
        markedM: null,
        routeLengthM: null,
      },
      {
        code: 'TRENCH_LONGER_THAN_ROUTE',
        markIds: [],
        routeHandle: 'A1F',
        featureId: null,
        markedM: '80.000',
        routeLengthM: '60.000',
      },
    ],
  };

  it('lists every issue in the message, in each language', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const { key, params } = publishBlockedMessage(details, locale);
      const text = translate(locale, key, params);
      expect(text).toContain('A1F');
      expect(text).toContain('80.000');
      expect(text).not.toBe(key);
    }
    const { key, params } = publishBlockedMessage(details, 'en');
    expect(translate('en', key, params)).toMatch(/installation method .* unclear (.*2.* issues)/);
  });

  it('is read out of the 409 details', () => {
    expect(publishBlockedOf(new ApiClientError('CONFLICT', 409, details))).toEqual(details);
  });
});

describe('BOX_TYPES_UNCLEAR refusal (ADR-043)', () => {
  const shape = `v1-${'a'.repeat(64)}`;
  const details: PublishBlockedDetails = {
    reason: 'BOX_TYPES_UNCLEAR',
    drawingKind: 'secondary',
    issueCount: 2,
    issues: [
      { code: 'BOX_TYPE_UNSET', shape, boxCount: 197, workOrderLineId: null },
      { code: 'WORK_ORDER_MISSING', shape: null, boxCount: null, workOrderLineId: null },
    ],
  };

  it('names the drawing and lists every issue, in each language', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const { key, params } = publishBlockedMessage(details, locale);
      const text = translate(locale, key, params);
      expect(text).toContain('aaaaaa');
      expect(text).toContain('197');
      expect(text).not.toBe(key);
    }
    const { key, params } = publishBlockedMessage(details, 'en');
    expect(translate('en', key, params)).toMatch(/box types .* unclear/);
  });

  it('is read out of the 409 details', () => {
    expect(publishBlockedOf(new ApiClientError('CONFLICT', 409, details))).toEqual(details);
  });
});
