import { translate } from '@ftth/i18n';
import { describe, expect, it } from 'vitest';
import {
  SITE_A,
  draftRevision,
  drawing,
  published,
  siteDrawings,
} from '@/test-utils/site-drawings';
import {
  canWithdraw,
  defaultChoice,
  drawingState,
  drawingsOfSite,
  generalOf,
  missingKinds,
  secondariesOf,
  siteDraftRevisionId,
  toUploadQuery,
  uploadOptions,
  uploadRefusalOf,
  versionChoice,
} from './site-drawings';

describe('upload options of a site', () => {
  const drawings = drawingsOfSite(siteDrawings(), SITE_A);

  it('a General that exists takes only a new version', () => {
    const options = uploadOptions(drawings, 'general');
    expect(options.canCreate).toBe(false);
    expect(options.versions.map((d) => d.kind)).toEqual(['general']);
    expect(defaultChoice(options, 'general')).toBe(versionChoice(drawings[0]?.id as string));
  });

  it('a site without a General offers a new General, nothing to version', () => {
    const options = uploadOptions([], 'general');
    expect(options).toEqual({ canCreate: true, versions: [] });
    expect(defaultChoice(options, 'general')).toBe('new_drawing');
  });

  it('a Secondary offers a new drawing and a version of each Secondary, in order', () => {
    const options = uploadOptions(drawings, 'secondary');
    expect(options.canCreate).toBe(true);
    expect(options.versions.map((d) => d.ordinal)).toEqual([1, 2]);
    // The user must choose: no default while there are Secondaries.
    expect(defaultChoice(options, 'secondary')).toBeNull();
  });

  it('the first Secondary of a site needs no question', () => {
    expect(defaultChoice(uploadOptions([], 'secondary'), 'secondary')).toBe('new_drawing');
  });
});

describe('upload query', () => {
  const site = SITE_A;
  const secondary = drawing(2, { kind: 'secondary', ordinal: 1 });

  it('is null until the site, kind and target are known', () => {
    expect(toUploadQuery({ siteId: null, kind: 'general', choice: 'new_drawing' })).toBeNull();
    expect(toUploadQuery({ siteId: site, kind: null, choice: 'new_drawing' })).toBeNull();
    expect(toUploadQuery({ siteId: site, kind: 'secondary', choice: null })).toBeNull();
  });

  it('a new drawing carries no drawingId', () => {
    expect(toUploadQuery({ siteId: site, kind: 'secondary', choice: 'new_drawing' })).toEqual({
      siteId: site,
      kind: 'secondary',
      target: 'new_drawing',
    });
  });

  it('a new version carries the drawingId', () => {
    expect(
      toUploadQuery({ siteId: site, kind: 'secondary', choice: versionChoice(secondary.id) }),
    ).toEqual({ siteId: site, kind: 'secondary', target: 'new_version', drawingId: secondary.id });
  });
});

describe('upload refusals', () => {
  const drawingId = '4d000000-0000-4000-8000-000000000001';
  const siteId = SITE_A;

  it.each([
    [
      { reason: 'GENERAL_EXISTS', siteId, drawingId, currentFileName: 'g.dxf' },
      /already has its General/,
    ],
    [{ reason: 'SITE_NOT_FOUND', siteId }, /not on the work order/],
    [{ reason: 'DRAWING_NOT_IN_SITE', drawingId, siteId }, /does not belong to the chosen site/],
    [{ reason: 'DRAWING_UNASSIGNED', drawingId }, /not linked to a site yet/],
  ] as const)('says %j in plain words in every language', (details, expected) => {
    const refusal = uploadRefusalOf(details);
    expect(refusal).not.toBeNull();
    if (!refusal) return;
    expect(translate('en', refusal.key, refusal.params)).toMatch(expected);
    expect(translate('ar', refusal.key, refusal.params)).not.toBe(refusal.key);
    expect(translate('fr', refusal.key, refusal.params)).not.toBe(refusal.key);
  });

  it('names the current General file', () => {
    const refusal = uploadRefusalOf({
      reason: 'GENERAL_EXISTS',
      siteId,
      drawingId,
      currentFileName: 'route-14.dxf',
    });
    expect(refusal && translate('en', refusal.key, refusal.params)).toContain('route-14.dxf');
  });

  it('ignores details it does not know', () => {
    expect(uploadRefusalOf({ reason: 'SOMETHING_ELSE' })).toBeNull();
    expect(uploadRefusalOf(null)).toBeNull();
  });
});

describe('drawing state', () => {
  it('an open revision wins over an older published one', () => {
    const d = drawing(1, { openRevision: draftRevision(1), latestPublished: published(1) });
    expect(drawingState(d)).toBe('draft');
  });

  it('is published with only a published revision, not built with none', () => {
    expect(drawingState(drawing(1, { latestPublished: published(3) }))).toBe('published');
    expect(drawingState(drawing(1))).toBe('not_built');
  });

  it('follows the build state of an open revision', () => {
    for (const status of ['queued', 'building'] as const) {
      expect(drawingState(drawing(1, { openRevision: { id: draftRevision(1).id, status } }))).toBe(
        status,
      );
    }
  });

  it('only a never-published drawing can be withdrawn', () => {
    expect(canWithdraw(drawing(1))).toBe(true);
    expect(canWithdraw(drawing(1, { openRevision: draftRevision(1) }))).toBe(true);
    expect(canWithdraw(drawing(1, { latestPublished: published(1) }))).toBe(false);
    expect(canWithdraw(drawing(1, { withdrawnAt: '2026-11-02T10:00:00.000Z' }))).toBe(false);
  });
});

describe('site helpers', () => {
  const drawings = drawingsOfSite(siteDrawings(), SITE_A);

  it('finds the General and the ordered Secondaries', () => {
    expect(generalOf(drawings)?.kind).toBe('general');
    expect(secondariesOf(drawings).map((d) => d.ordinal)).toEqual([1, 2]);
  });

  it('lists what a site still lacks', () => {
    expect(missingKinds(drawings)).toEqual([]);
    expect(missingKinds([])).toEqual(['general', 'secondary']);
    expect(missingKinds(drawings.filter((d) => d.kind === 'general'))).toEqual(['secondary']);
  });

  it('picks a draft revision of the site to publish with', () => {
    expect(siteDraftRevisionId(drawings)).toBe(draftRevision(2).id);
    expect(siteDraftRevisionId(drawings.filter((d) => d.kind === 'general'))).toBeNull();
  });
});
