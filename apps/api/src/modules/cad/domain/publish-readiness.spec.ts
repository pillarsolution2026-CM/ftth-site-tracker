import {
  DRAWING_FLOW_ALL_ON,
  DRAWING_FLOW_DEFAULT,
  evaluateBoxTypes,
  evaluateInstallation,
  type DrawingFlow,
  type DrawingKind,
  type Placement,
} from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  cabinetsInOtherSites,
  siteBlocker,
  siteReadiness,
  type PublishFacts,
  type SiteDrawingFacts,
  type SiteFacts,
} from './publish-readiness.js';

const SITE = 'abababab-abab-4bab-8bab-abababababab';
const OTHER = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const G = '10000000-0000-4000-8000-000000000001';
const S1 = '10000000-0000-4000-8000-000000000002';
const S2 = '10000000-0000-4000-8000-000000000003';

const PLACEMENT: Placement = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
} as Placement;

/** The check results as the use cases build them for the given switches. */
function factsOf(
  kind: DrawingKind,
  flow: DrawingFlow,
  drawingId: string,
  ordinal: number,
  patch: Partial<PublishFacts> = {},
  rolesMissing = false,
): PublishFacts {
  return {
    status: 'draft',
    drawingKind: kind,
    drawingId,
    ordinal,
    placement: PLACEMENT,
    problemTotal: 0,
    warningTotal: 0,
    installation: evaluateInstallation({
      drawingKind: kind,
      frozen: null,
      routes: [],
      merges: [],
      flow,
    }),
    boxTypes: {
      ...evaluateBoxTypes({
        applies: kind === 'secondary' && flow.boxTypes && !rolesMissing,
        rolesMissing,
        gallery: null,
        frozen: null,
        workOrderExists: true,
        workOrderLineIds: new Set(),
      }),
      changedSinceBuild: false,
    },
    open: { textLinksToReview: 0, diffConflicts: 0 },
    ...patch,
  };
}

/** A drawing with a draft and its effective cabinets. */
function draft(
  kind: DrawingKind,
  drawingId: string,
  ordinal: number,
  cabinets: (string | null)[],
  flow: DrawingFlow = DRAWING_FLOW_DEFAULT,
  patch: Partial<PublishFacts> = {},
): SiteDrawingFacts {
  return {
    drawingId,
    kind,
    ordinal,
    draft: {
      revisionId: `rev-${drawingId}`,
      facts: factsOf(kind, flow, drawingId, ordinal, patch),
    },
    hasPublished: false,
    notReady: null,
    subCabinets: cabinets,
  };
}

const published = (
  kind: DrawingKind,
  drawingId: string,
  ordinal: number,
  cabinets: (string | null)[],
): SiteDrawingFacts => ({
  drawingId,
  kind,
  ordinal,
  draft: null,
  hasPublished: true,
  notReady: null,
  subCabinets: cabinets,
});

const site = (
  drawings: SiteDrawingFacts[],
  otherSites: SiteFacts['otherSites'] = [],
): SiteFacts => ({
  siteId: SITE,
  drawings,
  otherSites,
});

describe('siteReadiness and the drawing-flow switches (ADR-045)', () => {
  it('lists the switched-off checks and keeps them ok', () => {
    const ready = siteReadiness(
      site([draft('general', G, 1, ['1-1']), draft('secondary', S1, 1, ['1-1'])]),
      DRAWING_FLOW_DEFAULT,
      null,
    );
    expect(ready.switchedOff).toEqual(['installation', 'box_types']);
    expect(ready.checks.find((c) => c.key === 'installation')).toMatchObject({ ok: true });
    expect(ready.checks.find((c) => c.key === 'box_types')).toMatchObject({ ok: true });
    expect(ready.checks.find((c) => c.key === 'site_drawings')?.ok).toBe(true);
    expect(ready.canPublish).toBe(true);
    expect(ready.siteRevisionIds).toHaveLength(2);
    expect(ready.drawings.map((d) => d.state)).toEqual(['draft', 'draft']);
  });

  it('lists only the steps that are off', () => {
    const facts = site([draft('general', G, 1, []), draft('secondary', S1, 1, [])]);
    const onlyBoxes = { ...DRAWING_FLOW_ALL_ON, boxTypes: false };
    expect(siteReadiness(facts, onlyBoxes, null).switchedOff).toEqual(['box_types']);
    const onlyInstall = { ...DRAWING_FLOW_ALL_ON, installationQuestion: false };
    expect(siteReadiness(facts, onlyInstall, null).switchedOff).toEqual(['installation']);
    expect(siteReadiness(facts, DRAWING_FLOW_ALL_ON, null).switchedOff).toEqual([]);
  });

  it('still blocks a legacy-mode Secondary (READING_ROLES_MISSING) with box types off', () => {
    const legacy = draft('secondary', S1, 1, ['1-1'], DRAWING_FLOW_DEFAULT);
    legacy.draft = {
      revisionId: 'rev-s',
      facts: factsOf('secondary', DRAWING_FLOW_DEFAULT, S1, 1, {}, true),
    };
    const facts = site([draft('general', G, 1, ['1-1']), legacy]);
    const ready = siteReadiness(facts, DRAWING_FLOW_DEFAULT, null);
    expect(ready.checks.find((c) => c.key === 'box_types')?.ok).toBe(false);
    expect(ready.canPublish).toBe(false);
    expect(siteBlocker(facts)).toMatchObject({
      reason: 'BOX_TYPES_UNCLEAR',
      drawingId: S1,
      ordinal: 1,
      issues: [{ code: 'READING_ROLES_MISSING' }],
    });
  });
});

describe('siteBlocker (ADR-049 part B)', () => {
  it('needs a General and a Secondary: SITE_INCOMPLETE names what is missing', () => {
    expect(siteBlocker(site([draft('general', G, 1, [])]))).toEqual({
      reason: 'SITE_INCOMPLETE',
      siteId: SITE,
      missingKinds: ['secondary'],
    });
    expect(siteBlocker(site([draft('secondary', S1, 1, [])]))).toMatchObject({
      missingKinds: ['general'],
    });
  });

  it('holds the site back while a drawing has no revision or is building', () => {
    const idle: SiteDrawingFacts = {
      drawingId: S2,
      kind: 'secondary',
      ordinal: 2,
      draft: null,
      hasPublished: false,
      notReady: 'no_revision',
      subCabinets: null,
    };
    const facts = site([draft('general', G, 1, ['1-1']), draft('secondary', S1, 1, ['1-1']), idle]);
    expect(siteBlocker(facts)).toEqual({
      reason: 'DRAWING_NOT_READY',
      drawingKind: 'secondary',
      drawingId: S2,
      ordinal: 2,
      state: 'no_revision',
    });
    const ready = siteReadiness(facts, DRAWING_FLOW_DEFAULT, null);
    expect(ready.canPublish).toBe(false);
    expect(ready.checks.find((c) => c.key === 'site_drawings')).toEqual({
      key: 'site_drawings',
      ok: false,
      count: 1,
    });
  });

  it('a Secondary with errors holds the whole site back, naming that drawing', () => {
    const facts = site([
      draft('general', G, 1, ['1-1', '2-1']),
      draft('secondary', S1, 1, ['1-1']),
      draft('secondary', S2, 2, ['2-1'], DRAWING_FLOW_DEFAULT, { problemTotal: 3 }),
    ]);
    expect(siteBlocker(facts)).toMatchObject({
      reason: 'PROBLEMS_OPEN',
      drawingId: S2,
      ordinal: 2,
      problemCount: 3,
    });
    expect(siteReadiness(facts, DRAWING_FLOW_DEFAULT, null).canPublish).toBe(false);
  });

  it('a new version of one Secondary publishes alone when the rest is published and cabinets still match', () => {
    const facts = site([
      published('general', G, 1, ['1-1', '2-1']),
      published('secondary', S1, 1, ['1-1']),
      draft('secondary', S2, 2, ['2-1']),
    ]);
    expect(siteBlocker(facts)).toBeNull();
    const ready = siteReadiness(facts, DRAWING_FLOW_DEFAULT, null);
    expect(ready.siteRevisionIds).toEqual([`rev-${S2}`]);
    expect(ready.canPublish).toBe(true);
    expect(ready.drawings.map((d) => d.state)).toEqual(['published', 'published', 'draft']);
  });

  it('checks the cabinets against the effective set: the General is the union of the Secondaries', () => {
    const facts = site([
      published('general', G, 1, ['1-1', '2-1']),
      published('secondary', S1, 1, ['1-1']),
      draft('secondary', S2, 2, ['2-1', '2-2']),
    ]);
    const blocker = siteBlocker(facts);
    expect(blocker).toMatchObject({ reason: 'CABINETS_MISMATCH' });
    if (blocker?.reason === 'CABINETS_MISMATCH') {
      expect(blocker.cabinets.missingInGeneral).toEqual(['2-2']);
    }
  });

  it('a cabinet name in two Secondaries of one site is a mismatch', () => {
    const facts = site([
      draft('general', G, 1, ['1-1']),
      draft('secondary', S1, 1, ['1-1']),
      draft('secondary', S2, 2, ['1-1']),
    ]);
    const blocker = siteBlocker(facts);
    expect(blocker).toMatchObject({ reason: 'CABINETS_MISMATCH' });
    if (blocker?.reason === 'CABINETS_MISMATCH') {
      expect(blocker.cabinets.inSeveralSecondaries).toEqual(['1-1']);
    }
  });

  it('refuses a cabinet name that another site of the work order has: CABINET_IN_OTHER_SITE', () => {
    const facts = site(
      [draft('general', G, 1, ['1-1', '1-2']), draft('secondary', S1, 1, ['1 - 1', '1-2'])],
      [{ siteId: OTHER, siteName: 'موقع آخر', names: ['1-1', null, '9-9'] }],
    );
    expect(cabinetsInOtherSites(facts)).toEqual([
      { name: '1-1', otherSiteId: OTHER, otherSiteName: 'موقع آخر' },
    ]);
    expect(siteBlocker(facts)).toMatchObject({
      reason: 'CABINET_IN_OTHER_SITE',
      cabinets: [{ name: '1-1', otherSiteId: OTHER }],
    });
    const ready = siteReadiness(facts, DRAWING_FLOW_DEFAULT, null);
    expect(ready.checks.find((c) => c.key === 'cabinets_other_site')).toEqual({
      key: 'cabinets_other_site',
      ok: false,
      count: 1,
    });
    expect(ready.canPublish).toBe(false);
  });

  it('the cabinets of other sites do not block when no name repeats', () => {
    const facts = site(
      [draft('general', G, 1, ['1-1']), draft('secondary', S1, 1, ['1-1'])],
      [{ siteId: OTHER, siteName: 'x', names: ['2-1'] }],
    );
    expect(siteBlocker(facts)).toBeNull();
  });

  it('sums the open items of the drafts and asks for the acknowledgement', () => {
    const facts = site([
      draft('general', G, 1, ['1-1'], DRAWING_FLOW_DEFAULT, {
        open: { textLinksToReview: 2, diffConflicts: 1 },
      }),
      draft('secondary', S1, 1, ['1-1'], DRAWING_FLOW_DEFAULT, {
        open: { textLinksToReview: 1, diffConflicts: 0 },
      }),
    ]);
    const ready = siteReadiness(facts, DRAWING_FLOW_DEFAULT, null);
    expect(ready.checks.find((c) => c.key === 'open_items')).toEqual({
      key: 'open_items',
      ok: false,
      count: 4,
    });
    expect(ready.needsAcknowledgement).toBe(true);
    expect(ready.canPublish).toBe(true);
  });
});
