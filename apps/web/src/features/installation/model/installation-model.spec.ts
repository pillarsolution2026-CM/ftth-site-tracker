import { translate } from '@ftth/i18n';
import type { InstallationState, TrenchMark } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  activeMarks,
  installationErrorKey,
  issueMessage,
  markedByRoute,
  needsRebuild,
  normaliseLengthText,
  parseTrenchLength,
} from './installation-model';

const FILE = '33333333-3333-4333-8333-333333333333';
const ANSWER = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555551';
const M2 = '55555555-5555-4555-8555-555555555552';
const M3 = '55555555-5555-4555-8555-555555555553';

function mark(id: string, routeHandle: string, lengthM: string, withdrawn = false): TrenchMark {
  return {
    id,
    cadFileId: FILE,
    routeHandle,
    lengthM,
    createdBy: null,
    createdAt: '2026-11-12T10:00:00.000Z',
    withdrawnBy: null,
    withdrawnAt: withdrawn ? '2026-11-12T11:00:00.000Z' : null,
  };
}

function state(marks: TrenchMark[], overrides: Partial<InstallationState> = {}): InstallationState {
  return {
    cadFileId: FILE,
    drawingKind: 'general',
    asked: true,
    answer: {
      id: ANSWER,
      cadFileId: FILE,
      answer: 'has_trench',
      answeredBy: null,
      answeredAt: '2026-11-12T10:00:00.000Z',
    },
    answerHistory: [],
    marks,
    activeMarkCount: marks.filter((m) => m.withdrawnAt === null).length,
    activeTrenchM: '0.000',
    ...overrides,
  };
}

describe('parseTrenchLength', () => {
  it.each([
    ['25.5', '25.500'],
    ['  12 ', '12.000'],
    ['0.125', '0.125'],
    ['١٢٫٥', '12.500'],
    ['7,25', '7.250'],
  ])('accepts %s as %s m', (typed, metres) => {
    expect(parseTrenchLength(typed)).toEqual({ ok: true, metres });
  });

  it.each(['', '0', '0.000', '-5', '1.2345', 'abc', '100000.001', '1e3'])('refuses %j', (typed) => {
    expect(parseTrenchLength(typed)).toEqual({ ok: false });
  });

  it('accepts the largest length', () => {
    expect(parseTrenchLength('100000')).toEqual({ ok: true, metres: '100000.000' });
  });

  it('turns Arabic digits and separators into plain ones', () => {
    expect(normaliseLengthText(' ٣٫١٤ ')).toBe('3.14');
  });
});

describe('marks in force', () => {
  const marks = [mark(M1, 'A1', '10.250'), mark(M2, 'A1', '4.750'), mark(M3, 'B2', '9', true)];

  it('keeps withdrawn marks out of the totals', () => {
    expect(activeMarks(state(marks)).map((m) => m.id)).toEqual([M1, M2]);
    expect(markedByRoute(marks)).toEqual(new Map([['A1', '15.000']]));
  });
});

describe('needsRebuild', () => {
  const marks = [mark(M1, 'A1', '10.250')];
  const frozen = {
    answer: 'has_trench' as const,
    answerId: ANSWER,
    marks: [{ id: M1, routeHandle: 'A1', lengthM: '10.250' }],
  };

  it('is false when the draft froze what is live', () => {
    expect(needsRebuild(frozen, state(marks))).toBe(false);
  });

  it('is true for a new mark, a withdrawn mark, a new answer, or a draft built before', () => {
    expect(needsRebuild(frozen, state([...marks, mark(M2, 'B2', '5')]))).toBe(true);
    expect(needsRebuild(frozen, state([mark(M1, 'A1', '10.250', true)]))).toBe(true);
    expect(needsRebuild({ ...frozen, answerId: M3 }, state(marks))).toBe(true);
    expect(needsRebuild(null, state(marks))).toBe(true);
  });

  it('is never needed for a Secondary or before the state is read', () => {
    expect(needsRebuild(null, state([], { asked: false, answer: null }))).toBe(false);
    expect(needsRebuild(null, undefined)).toBe(false);
  });
});

describe('messages', () => {
  it.each([
    'NOT_GENERAL_DRAWING',
    'FILE_SUPERSEDED',
    'NOT_PROCESSED',
    'ANSWER_NOT_TRENCH',
    'TRENCH_MARKS_ACTIVE',
    'ROUTE_NOT_FOUND',
    'TOO_MANY_MARKS',
    'TOO_MANY_ANSWERS',
    'ALREADY_WITHDRAWN',
  ])('has its own text for the refusal %s in every language', (reason) => {
    const code = reason === 'ROUTE_NOT_FOUND' ? 'VALIDATION_FAILED' : 'CONFLICT';
    const key = installationErrorKey(code, reason);
    expect(key).toBe(`design.installation.error.${reason}`);
    for (const locale of ['ar', 'en', 'fr'] as const) {
      expect(translate(locale, key)).not.toBe(key);
    }
  });

  it('falls back to the generic message', () => {
    expect(installationErrorKey('CONFLICT', 'SOMETHING_ELSE')).toBe('errors.CONFLICT');
    expect(installationErrorKey('FORBIDDEN', null)).toBe('errors.FORBIDDEN');
  });

  it.each([
    'QUESTION_UNANSWERED',
    'TRENCH_NOT_MARKED',
    'MARKS_WITH_PULL_ONLY',
    'MARK_ROUTE_MISSING',
    'ROUTE_LENGTH_UNKNOWN',
    'TRENCH_LONGER_THAN_ROUTE',
  ] as const)('writes the issue %s with its route and metres, LTR isolated', (code) => {
    const { key, params } = issueMessage({
      code,
      markIds: [],
      routeHandle: 'A1F',
      featureId: null,
      markedM: '80.000',
      routeLengthM: '60.000',
    });
    const text = translate('ar', key, params);
    expect(text).not.toBe(key);
    if (code === 'TRENCH_LONGER_THAN_ROUTE') {
      expect(text).toContain('⁦A1F⁩');
      expect(text).toContain('⁦80.000⁩');
      expect(text).toContain('⁦60.000⁩');
    }
  });
});
