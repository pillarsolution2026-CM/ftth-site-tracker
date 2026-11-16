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
import { publishBlocker, publishReadiness, type PublishFacts } from './publish-readiness.js';

const PLACEMENT: Placement = {
  sourceCrs: 'project',
  points: [{ id: 'p1', drawing: { x: 1, y: 1 }, lat: 30.9, lon: 32.7, source: 'typed' }],
} as Placement;

/** The check results as the use cases build them for the given switches. */
function factsOf(kind: DrawingKind, flow: DrawingFlow, rolesMissing = false): PublishFacts {
  return {
    status: 'draft',
    drawingKind: kind,
    placement: PLACEMENT,
    problemTotal: 0,
    warningTotal: 0,
    subCabinets: [],
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
  };
}

describe('publishReadiness and the drawing-flow switches (ADR-045)', () => {
  it('lists the switched-off checks and keeps them ok', () => {
    const general = factsOf('general', DRAWING_FLOW_DEFAULT);
    const secondary = factsOf('secondary', DRAWING_FLOW_DEFAULT);
    const ready = publishReadiness(
      general,
      { revisionId: 'other', facts: secondary },
      DRAWING_FLOW_DEFAULT,
    );
    expect(ready.switchedOff).toEqual(['installation', 'box_types']);
    expect(ready.checks.find((c) => c.key === 'installation')).toMatchObject({ ok: true });
    expect(ready.checks.find((c) => c.key === 'box_types')).toMatchObject({ ok: true });
    expect(ready.checks.find((c) => c.key === 'other_drawing')?.ok).toBe(true);
    expect(ready.installation).toBeNull();
    expect(ready.boxTypes).toBeNull();
    expect(ready.canPublish).toBe(true);
    expect(publishBlocker(general, secondary)).toBeNull();
  });

  it('lists only the steps that are off', () => {
    const onlyBoxes = { ...DRAWING_FLOW_ALL_ON, boxTypes: false };
    expect(publishReadiness(factsOf('general', onlyBoxes), null, onlyBoxes).switchedOff).toEqual([
      'box_types',
    ]);
    const onlyInstall = { ...DRAWING_FLOW_ALL_ON, installationQuestion: false };
    expect(
      publishReadiness(factsOf('general', onlyInstall), null, onlyInstall).switchedOff,
    ).toEqual(['installation']);
    expect(
      publishReadiness(factsOf('general', DRAWING_FLOW_ALL_ON), null, DRAWING_FLOW_ALL_ON)
        .switchedOff,
    ).toEqual([]);
  });

  it('reading totals alone switch nothing off', () => {
    const flow = { ...DRAWING_FLOW_ALL_ON, readingTotals: false };
    expect(publishReadiness(factsOf('general', flow), null, flow).switchedOff).toEqual([]);
  });

  it('still blocks a legacy-mode Secondary (READING_ROLES_MISSING) with box types off', () => {
    const general = factsOf('general', DRAWING_FLOW_DEFAULT);
    const legacy = factsOf('secondary', DRAWING_FLOW_DEFAULT, true);
    const ready = publishReadiness(
      legacy,
      { revisionId: 'g', facts: general },
      DRAWING_FLOW_DEFAULT,
    );
    expect(ready.switchedOff).toContain('box_types');
    expect(ready.checks.find((c) => c.key === 'box_types')?.ok).toBe(false);
    expect(ready.canPublish).toBe(false);
    expect(publishBlocker(general, legacy)).toMatchObject({
      reason: 'BOX_TYPES_UNCLEAR',
      issues: [{ code: 'READING_ROLES_MISSING' }],
    });
  });
});
