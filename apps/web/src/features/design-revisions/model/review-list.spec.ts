import { describe, expect, it } from 'vitest';
import { DEFAULT_DIFF_FILTER, diffQuery } from './diff-view';
import { publishBlockedOf, revisionErrorKey } from './revision-errors';
import {
  DEFAULT_REVIEW_FILTER,
  allowedFeatureTypes,
  hasOpenItems,
  linkActions,
  linkTextOf,
  openItemsOf,
  reviewQuery,
  sortByConfidence,
} from './review-list';
import { isBuilding, isBuilt } from './revision-status';
import { ApiClientError } from '@/shared/api/bff-client';
import { link } from './review-fixtures';

describe('review list helpers', () => {
  it('opens on status=review and omits "all" filters from the query', () => {
    expect(reviewQuery(DEFAULT_REVIEW_FILTER, 1)).toEqual({
      page: 1,
      pageSize: 50,
      status: 'review',
    });
    expect(reviewQuery({ status: 'all', kind: 'box_id' }, 2)).toEqual({
      page: 2,
      pageSize: 50,
      kind: 'box_id',
    });
  });

  it('sorts the least confident first and by handle for equal confidence', () => {
    const sorted = sortByConfidence([
      link({ id: 'a', confidence: '0.9', textHandle: 'A' }),
      link({ id: 'b', confidence: '0.1', textHandle: 'Z' }),
      link({ id: 'c', confidence: '0.1', textHandle: 'B' }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('shows the raw text, marked unreadable, when a text cannot be read', () => {
    expect(linkTextOf(link())).toEqual({ unreadable: false, text: 'F 36 C' });
    expect(linkTextOf(link({ readable: false, text: null, rawText: '%%U\\M+ABCD' }))).toEqual({
      unreadable: true,
      text: '%%U\\M+ABCD',
    });
  });

  it('offers confirm only with a proposed feature, and nothing without review rights', () => {
    expect(linkActions(link(), true)).toEqual({ confirm: true, reject: true, reassign: true });
    expect(linkActions(link({ featureId: null, featureType: null }), true).confirm).toBe(false);
    expect(linkActions(link({ status: 'confirmed' }), true).confirm).toBe(false);
    expect(linkActions(link({ status: 'rejected' }), true).reject).toBe(false);
    expect(linkActions(link(), false)).toEqual({ confirm: false, reject: false, reassign: false });
  });

  it('limits reassignment to the feature types allowed for the kind', () => {
    expect(allowedFeatureTypes('box_id')).toEqual(['box']);
    expect(allowedFeatureTypes('cable')).toEqual(['route']);
    expect(allowedFeatureTypes('unreadable')).toHaveLength(5);
  });

  it('counts open items from link and diff counts', () => {
    const items = openItemsOf(
      { auto: 5, review: 3, confirmed: 0, rejected: 0, unlinked: 1 },
      {
        added: 0,
        removed: 0,
        unchanged: 0,
        moved: 0,
        reshaped: 0,
        attributes_changed: 0,
        conflict: 2,
      },
    );
    expect(items).toEqual({ textLinksToReview: 3, diffConflicts: 2 });
    expect(hasOpenItems(items)).toBe(true);
    expect(hasOpenItems(openItemsOf(null, null))).toBe(false);
  });
});

describe('diff query', () => {
  it('hides unchanged rows by default', () => {
    expect(diffQuery(DEFAULT_DIFF_FILTER, 1)).toEqual({ page: 1, pageSize: 50, changedOnly: true });
  });

  it('a specific change overrides "changed only" so unchanged can be listed', () => {
    expect(diffQuery({ change: 'unchanged', changedOnly: true }, 1)).toEqual({
      page: 1,
      pageSize: 50,
      change: 'unchanged',
      changedOnly: false,
    });
  });
});

describe('revision status and errors', () => {
  it('polls while queued or building and has data once draft or published', () => {
    expect(isBuilding('queued')).toBe(true);
    expect(isBuilding('building')).toBe(true);
    expect(isBuilding('draft')).toBe(false);
    expect(isBuilt('draft')).toBe(true);
    expect(isBuilt('published')).toBe(true);
    expect(isBuilt('failed')).toBe(false);
  });

  it('reads the OPEN_ITEMS counts from a 409', () => {
    const error = new ApiClientError('CONFLICT', 409, {
      reason: 'OPEN_ITEMS',
      textLinksToReview: 4,
      diffConflicts: 1,
    });
    expect(publishBlockedOf(error)).toEqual({
      reason: 'OPEN_ITEMS',
      textLinksToReview: 4,
      diffConflicts: 1,
    });
    expect(
      publishBlockedOf(new ApiClientError('CONFLICT', 409, { reason: 'NOT_DRAFT' })),
    ).toBeNull();
    expect(publishBlockedOf(new Error('x'))).toBeNull();
  });

  it('maps reasons to messages', () => {
    expect(revisionErrorKey('CONFLICT', 'REVISION_LOCKED')).toBe('design.error.REVISION_LOCKED');
    expect(revisionErrorKey('VALIDATION_FAILED', 'FEATURE_TYPE_NOT_ALLOWED')).toBe(
      'design.error.FEATURE_TYPE_NOT_ALLOWED',
    );
    expect(revisionErrorKey('CONFLICT', 'OTHER')).toBe('errors.CONFLICT');
    expect(revisionErrorKey('NOT_FOUND', null)).toBe('errors.NOT_FOUND');
  });
});
