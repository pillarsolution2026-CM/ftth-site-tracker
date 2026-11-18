import type { PublishBlockedDetails } from '@ftth/shared';
import { translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { publishBlockedMessage, publishBlockedOf } from './revision-errors';

describe('publish refusal messages', () => {
  it.each([
    [
      {
        reason: 'CRS_UNKNOWN',
        drawingKind: 'general',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
      },
      /coordinate system .* never chosen/,
    ],
    [
      {
        reason: 'PLACEMENT_MISSING',
        drawingKind: 'general',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
      },
      /no control point in use/,
    ],
    [
      {
        reason: 'PROBLEMS_OPEN',
        drawingKind: 'general',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
        problemCount: 7,
      },
      /7.* drawing errors are left/,
    ],
    [{ reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 0 }, /not acknowledged/],
    [
      {
        reason: 'DRAWING_NOT_READY',
        drawingKind: 'secondary',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
        state: 'no_revision',
      },
      /Secondary .*1.* drawing is not ready: it has no revision yet/,
    ],
  ] as const)('has a clear message for %j', (details, expected) => {
    const { key, params } = publishBlockedMessage(details, 'en');
    expect(translate('en', key, params)).toMatch(expected);
    expect(translate('ar', key, params)).not.toBe(key);
    expect(translate('fr', key, params)).not.toBe(key);
  });

  it('names the drawing that blocks, in each language', () => {
    const secondary = publishBlockedMessage(
      {
        reason: 'DRAWING_NOT_READY',
        drawingKind: 'secondary',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
        state: 'no_revision',
      },
      'en',
    );
    expect(translate('en', secondary.key, secondary.params)).toMatch(
      /Secondary .*1.* drawing is not ready/,
    );
    const placement = publishBlockedMessage(
      {
        reason: 'PLACEMENT_MISSING',
        drawingKind: 'secondary',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
      },
      'en',
    );
    expect(translate('en', placement.key, placement.params)).toMatch(
      /Secondary drawing has no control point/,
    );
    const arabic = publishBlockedMessage(
      {
        reason: 'PROBLEMS_OPEN',
        drawingKind: 'general',
        drawingId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
        problemCount: 2,
      },
      'ar',
    );
    expect(translate('ar', arabic.key, arabic.params)).toContain('جينيرال (رئيسي)');
  });

  it('reads the reason out of a 409', () => {
    const error = new ApiClientError('CONFLICT', 409, {
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'general',
      drawingId: '11111111-1111-4111-8111-111111111111',
      ordinal: 1,
      problemCount: 3,
    });
    expect(publishBlockedOf(error)).toEqual({
      reason: 'PROBLEMS_OPEN',
      drawingKind: 'general',
      drawingId: '11111111-1111-4111-8111-111111111111',
      ordinal: 1,
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
      general: { drawingId: null, count: 9, unnamed: 0 },
      secondaries: [
        {
          drawingId: '11111111-1111-4111-8111-111111111111',
          ordinal: 1,
          side: { count: 8, unnamed: 1, missingInOther: [] },
        },
      ],
      inSeveralSecondaries: [],
      missingInGeneral: [],
      missingInSecondaries: ['1-9'],
    },
  };

  it('names both counts and the cabinets that exist in one drawing only', () => {
    const { key, params } = publishBlockedMessage(details, 'en');
    const text = translate('en', key, params);
    expect(text).toMatch(/General has .*9.*, the Secondaries have .*8/);
    expect(text).toMatch(/Only in the General: .*1-9/);
    expect(text).toMatch(/Only in a Secondary: —/);
    expect(text).toMatch(/more than one Secondary: —/);
    expect(text).toMatch(/with no name: .*1/);
    expect(translate('ar', key, params)).toMatch(/كبائن الموقع غير متطابقة/);
    expect(translate('fr', key, params)).not.toBe(key);
  });

  it('is read out of a 409', () => {
    expect(publishBlockedOf(new ApiClientError('CONFLICT', 409, details))).toEqual(details);
  });
});

describe('site refusals (ADR-049 part B)', () => {
  const drawingId = '11111111-1111-4111-8111-111111111111';

  it('names the cabinets that are in several Secondaries or missing from the General', () => {
    const { key, params } = publishBlockedMessage(
      {
        reason: 'CABINETS_MISMATCH',
        cabinets: {
          ok: false,
          general: { drawingId: null, count: 2, unnamed: 0 },
          secondaries: [],
          inSeveralSecondaries: ['3-3'],
          missingInGeneral: ['4-4'],
          missingInSecondaries: [],
        },
      },
      'en',
    );
    const text = translate('en', key, params);
    expect(text).toMatch(/Only in a Secondary: .*4-4/);
    expect(text).toMatch(/more than one Secondary: .*3-3/);
  });

  it('lists the cabinets of another site with that site, in each language', () => {
    const details: PublishBlockedDetails = {
      reason: 'CABINET_IN_OTHER_SITE',
      cabinets: [
        {
          name: '1-9',
          otherSiteId: '3b000000-0000-4000-8000-00000000000b',
          otherSiteName: 'Site B',
        },
        {
          name: '2-1',
          otherSiteId: '3b000000-0000-4000-8000-00000000000b',
          otherSiteName: 'Site B',
        },
      ],
    };
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const { key, params } = publishBlockedMessage(details, locale);
      const text = translate(locale, key, params);
      expect(text).toContain('1-9');
      expect(text).toContain('2-1');
      expect(text).toContain('Site B');
      expect(text).not.toBe(key);
    }
  });

  it('says which kind the site still lacks', () => {
    const { key, params } = publishBlockedMessage(
      {
        reason: 'SITE_INCOMPLETE',
        siteId: '3a000000-0000-4000-8000-00000000000a',
        missingKinds: ['secondary'],
      },
      'en',
    );
    expect(translate('en', key, params)).toMatch(/still needs Secondary/);
    expect(translate('ar', key, params)).toMatch(/ينقصه/);
  });

  it('asks to link an unassigned drawing to a site', () => {
    const { key, params } = publishBlockedMessage(
      { reason: 'SITE_UNASSIGNED', drawingKind: 'general', drawingId, ordinal: 1 },
      'en',
    );
    expect(translate('en', key, params)).toMatch(/not linked to a site/);
    expect(translate('fr', key, params)).toMatch(/aucun site/);
  });

  it.each([
    ['no_revision', /no revision yet/],
    ['building', /still being built/],
    ['queued', /waiting to be built/],
    ['failed', /last build failed/],
  ] as const)('explains a drawing that is %s', (state, expected) => {
    const { key, params } = publishBlockedMessage(
      { reason: 'DRAWING_NOT_READY', drawingKind: 'secondary', drawingId, ordinal: 2, state },
      'en',
    );
    expect(translate('en', key, params)).toMatch(expected);
  });
});

describe('INSTALLATION_UNCLEAR refusal (ADR-042)', () => {
  const details: PublishBlockedDetails = {
    reason: 'INSTALLATION_UNCLEAR',
    drawingKind: 'general',
    drawingId: '11111111-1111-4111-8111-111111111111',
    ordinal: 1,
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
    drawingId: '11111111-1111-4111-8111-111111111111',
    ordinal: 1,
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
