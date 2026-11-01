import type { AsBuiltLineString, AsBuiltPoint } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { bboxOf, fitTransform, pathData, scaleBar } from './drawing';
import { formatLengthDifference, lengthDifference } from './length';
import { makeDetail } from './asbuilt-fixtures';
import {
  EDITS_PAGE_SIZE,
  approveBlockedReason,
  exportErrorKey,
  isExportRunning,
  listQuery,
  reviewErrorKey,
} from './review-model';

describe('drawing fit', () => {
  const line: AsBuiltLineString = {
    type: 'LineString',
    coordinates: [
      [1000, 2000],
      [1100, 2050],
    ],
  };
  const point: AsBuiltPoint = { type: 'Point', coordinates: [1050, 2100] };

  it('takes the bounding box of every geometry and ignores missing ones', () => {
    expect(bboxOf([line, null, point, undefined])).toEqual({
      minX: 1000,
      minY: 2000,
      maxX: 1100,
      maxY: 2100,
    });
    expect(bboxOf([null])).toBeNull();
  });

  it('flips y so north is up and keeps the aspect ratio', () => {
    const box = bboxOf([line, point]);
    if (!box) throw new Error('box');
    const view = fitTransform(box, 600, 400, 40);
    // 100 m x 100 m in a 520 x 320 window: the height limits the scale.
    expect(view.scale).toBeCloseTo(3.2);
    const [, southY] = view.project([1000, 2000]);
    const [, northY] = view.project([1000, 2100]);
    expect(northY).toBeLessThan(southY);
    expect(northY).toBeCloseTo(40);
    expect(southY).toBeCloseTo(360);
    // East stays to the right and the drawing is centred.
    const [westX] = view.project([1000, 2000]);
    const [eastX] = view.project([1100, 2000]);
    expect(eastX).toBeGreaterThan(westX);
    expect((westX + eastX) / 2).toBeCloseTo(300);
  });

  it('gives a lone point a window instead of dividing by zero', () => {
    const box = bboxOf([point]);
    if (!box) throw new Error('box');
    const view = fitTransform(box, 600, 400, 40);
    expect(Number.isFinite(view.scale)).toBe(true);
    const [x, y] = view.project([1050, 2100]);
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(200);
  });

  it('writes SVG path data from projected positions', () => {
    const box = bboxOf([line]);
    if (!box) throw new Error('box');
    const view = fitTransform(box, 140, 90, 20);
    expect(pathData(line.coordinates, view)).toMatch(/^M20 \d+(\.\d+)? L120 \d+(\.\d+)?$/);
  });

  it('picks a round scale bar that fits', () => {
    const bar = scaleBar(3.2, 160);
    expect(bar.metres).toBe(50);
    expect(bar.px).toBeCloseTo(160);
    expect(scaleBar(0.5, 100).metres).toBe(200);
    expect(scaleBar(100, 160).metres).toBe(1);
  });
});

describe('length difference', () => {
  it('subtracts decimal strings exactly (no float drift)', () => {
    expect(lengthDifference('0.1', '0.3')).toEqual({ value: '0.2', direction: 'longer' });
    expect(lengthDifference('120.000', '122.066')).toEqual({ value: '2.066', direction: 'longer' });
    expect(lengthDifference('122.066', '120.000')).toEqual({
      value: '-2.066',
      direction: 'shorter',
    });
    expect(lengthDifference('10.500', '10.5')).toEqual({ value: '0', direction: 'same' });
  });

  it('has no difference without both lengths', () => {
    expect(lengthDifference(null, '10.000')).toBeNull();
    expect(lengthDifference('10.000', null)).toBeNull();
  });

  it('formats with a sign, millimetres and the locale separators', () => {
    expect(formatLengthDifference({ value: '2.066', direction: 'longer' }, 'en')).toBe('+2.066 m');
    expect(formatLengthDifference({ value: '-2.1', direction: 'shorter' }, 'en')).toBe('−2.100 m');
    expect(formatLengthDifference({ value: '1234.5', direction: 'longer' }, 'fr')).toBe(
      `+1${String.fromCharCode(0x202f)}234,500 m`,
    );
    expect(formatLengthDifference({ value: '0', direction: 'same' }, 'en')).toBe('0.000 m');
  });
});

describe('list query', () => {
  it('uses limit/offset from the page and leaves the status out for all', () => {
    expect(listQuery('pending', 1)).toEqual({
      status: 'pending',
      limit: EDITS_PAGE_SIZE,
      offset: 0,
    });
    expect(listQuery('rejected', 3)).toEqual({
      status: 'rejected',
      limit: EDITS_PAGE_SIZE,
      offset: 2 * EDITS_PAGE_SIZE,
    });
    expect(listQuery('all', 2)).toEqual({ limit: EDITS_PAGE_SIZE, offset: EDITS_PAGE_SIZE });
  });
});

describe('review rules shown to the user', () => {
  it('explains why approving is not possible', () => {
    expect(approveBlockedReason(makeDetail(), true)).toBeNull();
    expect(approveBlockedReason(makeDetail(), false)).toBe('noPermission');
    expect(approveBlockedReason(makeDetail({ status: 'approved' }), true)).toBe('notPending');
    expect(approveBlockedReason(makeDetail({}, { approvable: false }), true)).toBe('stale');
  });

  it('maps review refusals to their own messages', () => {
    expect(reviewErrorKey('FORBIDDEN', 'SELF_REVIEW')).toBe('asbuiltReview.error.SELF_REVIEW');
    expect(reviewErrorKey('CONFLICT', 'NOT_PENDING')).toBe('asbuiltReview.error.NOT_PENDING');
    expect(reviewErrorKey('CONFLICT', 'STALE_BASE')).toBe('asbuiltReview.error.STALE_BASE');
    expect(reviewErrorKey('FORBIDDEN', null)).toBe('errors.FORBIDDEN');
    expect(reviewErrorKey('CONFLICT', 'OTHER')).toBe('errors.CONFLICT');
    expect(reviewErrorKey('NETWORK', null)).toBe('errors.NETWORK');
  });

  it('maps the export refusal and tells running exports from finished ones', () => {
    expect(exportErrorKey('CONFLICT', 'NO_PUBLISHED_REVISION')).toBe(
      'asbuiltReview.exports.error.NO_PUBLISHED_REVISION',
    );
    expect(exportErrorKey('FORBIDDEN', null)).toBe('errors.FORBIDDEN');
    expect(isExportRunning('queued')).toBe(true);
    expect(isExportRunning('processing')).toBe(true);
    expect(isExportRunning('done')).toBe(false);
    expect(isExportRunning('failed')).toBe(false);
  });
});
