import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  decideRejection,
  isBaseOutdated,
  nextVersion,
  versionAxisOf,
  type ReviewFacts,
} from './review.js';

const base: ReviewFacts = {
  status: 'pending',
  kind: 'reshape',
  baseVersion: 0,
  editorId: 'u-editor',
  reviewerId: 'u-reviewer',
  current: { geometryVersion: 0, labelVersion: 0 },
};

describe('versionAxisOf / nextVersion', () => {
  it('maps kinds to their version axis', () => {
    expect(versionAxisOf('move')).toBe('geometry');
    expect(versionAxisOf('reshape')).toBe('geometry');
    expect(versionAxisOf('label')).toBe('label');
    expect(versionAxisOf('add_route')).toBeNull();
    expect(versionAxisOf('add_symbol')).toBeNull();
  });

  it('increments the right axis; an add is version 1', () => {
    const current = { geometryVersion: 3, labelVersion: 5 };
    expect(nextVersion('reshape', current)).toBe(4);
    expect(nextVersion('move', current)).toBe(4);
    expect(nextVersion('label', current)).toBe(6);
    expect(nextVersion('add_route', current)).toBe(1);
  });
});

describe('isBaseOutdated', () => {
  it('compares geometry edits with the geometry version only', () => {
    const current = { geometryVersion: 1, labelVersion: 4 };
    expect(isBaseOutdated('reshape', 1, current)).toBe(false);
    expect(isBaseOutdated('reshape', 0, current)).toBe(true);
  });

  it('compares label edits with the label version only', () => {
    const current = { geometryVersion: 7, labelVersion: 2 };
    expect(isBaseOutdated('label', 2, current)).toBe(false);
    expect(isBaseOutdated('label', 1, current)).toBe(true);
  });

  it('never flags an add', () => {
    expect(isBaseOutdated('add_route', null, { geometryVersion: 9, labelVersion: 9 })).toBe(false);
  });
});

describe('decideApproval', () => {
  it('approves a pending edit on the current base with the next version', () => {
    expect(decideApproval(base)).toEqual({ ok: true, approvedVersion: 1 });
    expect(
      decideApproval({
        ...base,
        baseVersion: 2,
        current: { geometryVersion: 2, labelVersion: 0 },
      }),
    ).toEqual({ ok: true, approvedVersion: 3 });
  });

  it('refuses one’s own edit before anything else', () => {
    expect(decideApproval({ ...base, reviewerId: base.editorId, status: 'approved' })).toEqual({
      ok: false,
      refusal: 'SELF_REVIEW',
    });
  });

  it('refuses an edit that is not pending', () => {
    expect(decideApproval({ ...base, status: 'approved' })).toEqual({
      ok: false,
      refusal: 'NOT_PENDING',
    });
    expect(decideApproval({ ...base, status: 'rejected' })).toEqual({
      ok: false,
      refusal: 'NOT_PENDING',
    });
  });

  it('refuses a stale base', () => {
    expect(
      decideApproval({ ...base, baseVersion: 0, current: { geometryVersion: 1, labelVersion: 0 } }),
    ).toEqual({ ok: false, refusal: 'STALE_BASE' });
  });

  it('approves an add without a base', () => {
    expect(
      decideApproval({
        ...base,
        kind: 'add_symbol',
        baseVersion: null,
        current: { geometryVersion: 0, labelVersion: 0 },
      }),
    ).toEqual({ ok: true, approvedVersion: 1 });
  });
});

describe('decideRejection', () => {
  it('rejects a pending edit of someone else, even on a stale base', () => {
    expect(decideRejection(base)).toEqual({ ok: true });
  });

  it('refuses self review and non-pending edits', () => {
    expect(decideRejection({ ...base, reviewerId: base.editorId })).toEqual({
      ok: false,
      refusal: 'SELF_REVIEW',
    });
    expect(decideRejection({ ...base, status: 'rejected' })).toEqual({
      ok: false,
      refusal: 'NOT_PENDING',
    });
  });
});
