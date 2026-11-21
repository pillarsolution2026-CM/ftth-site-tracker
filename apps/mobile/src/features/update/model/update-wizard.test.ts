import { createProjectCrs } from '@ftth/geo';
import type { CatalogItem, LinePerformer, OfflineBundle, OfflineFeature } from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';
import {
  acknowledge,
  buildRecordOp,
  canSave,
  chooseWorkType,
  computeWarnings,
  contractorLeft,
  contractorOverruns,
  goBack,
  goNext,
  itemsForActivity,
  missingPhotos,
  photoRequirementsFor,
  startDraft,
  SELF_PERFORMER as SELF,
  stepMaterial,
  stepProblems,
  stepWork,
  unsyncedTotals,
  workQuantity,
  type CapturedPhoto,
  type UpdateDraft,
} from './update-wizard';

const E = 330_000;
const N = 3_340_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const box: OfflineFeature = {
  id: id(1),
  type: 'box',
  code: '1-1',
  layer: 'sub',
  geometry: { type: 'Point', coordinates: [E, N] },
  lengthM: null,
};
const item = (
  n: number,
  workType: CatalogItem['workType'],
  quantity: string,
  recorded = '0',
): CatalogItem => ({
  id: id(100 + n),
  workOrderId: id(99),
  workOrderNumber: 'WO-1',
  lineNo: n,
  code: `C-${n}`,
  description: `item ${n}`,
  unit: 'عدد',
  quantity,
  workType,
  recordedQuantity: recorded,
  contractors: [],
});
const contractorLine = (n: number, quantity: string, recordedQuantity = '0') => ({
  contractorLineId: id(300 + n),
  contractorId: id(400 + n),
  contractorName: `contractor ${n}`,
  scope: null,
  quantity,
  recordedQuantity,
});
const via = (n: number): LinePerformer => ({ kind: 'contractor', contractorLineId: id(300 + n) });
const catalog = [item(1, 'civil', '10', '9'), item(2, 'civil', '5'), item(3, 'installation', '3')];
const settings: Pick<OfflineBundle, 'settings'> = {
  settings: {
    gpsWarningDistanceM: 50,
    suggestedQuantity: 'unavailable',
    photoRequirements: {
      status: 'unavailable',
      byWorkType: {},
      fallback: [{ key: 'general', minCount: 1 }],
    },
  },
};
const requirements = photoRequirementsFor(settings, 'civil');
const crs = createProjectCrs(32636);
const gpsAt = (e: number, n: number) => {
  const { lon, lat } = crs.toWgs84({ x: e, y: n });
  return { lon, lat, accuracyM: 5, at: '2026-10-30T08:00:00Z' };
};
const photo: CapturedPhoto = {
  photoId: id(500),
  requirementKey: 'general',
  fileUri: 'file://p.jpg',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  takenAt: '2026-10-30T08:00:00Z',
  gps: null,
};

function complete(): UpdateDraft {
  let draft = startDraft(box);
  draft = chooseWorkType(draft, 'civil');
  draft = stepWork(draft, id(101), SELF, 1);
  draft = stepMaterial(draft, id(102), 10);
  return { ...draft, gps: gpsAt(E + 10, N), photos: [photo], step: 'review' };
}

describe('update wizard', () => {
  it('walks the six steps forward only when each is complete, and back freely', () => {
    let draft = startDraft(box);
    expect(draft.label).toBe('1-1');
    expect(goNext(draft, requirements).step).toBe('activity');
    draft = goNext(chooseWorkType(draft, 'civil'), requirements);
    expect(draft.step).toBe('work');
    draft = goNext(draft, requirements); // work may be empty …
    expect(draft.step).toBe('materials');
    expect(stepProblems(draft, 'materials', requirements)).toEqual(['NO_LINES']); // … not both
    draft = goNext(stepMaterial(draft, id(102), 1), requirements);
    expect(draft.step).toBe('location');
    draft = goNext(draft, requirements);
    expect(draft.step).toBe('photos');
    expect(goNext(draft, requirements).step).toBe('photos'); // photos are mandatory
    draft = goNext({ ...draft, photos: [photo] }, requirements);
    expect(draft.step).toBe('review');
    expect(goBack(goBack(draft)).step).toBe('location');
    expect(goBack(startDraft(box)).step).toBe('activity');
  });

  it('offers only items of the chosen activity and resets lines when it changes', () => {
    expect(itemsForActivity(catalog, 'civil').map((i) => i.code)).toEqual(['C-1', 'C-2']);
    expect(itemsForActivity(catalog, null)).toEqual([]);
    const draft = stepWork(chooseWorkType(startDraft(box), 'civil'), id(101), SELF, 1);
    expect(chooseWorkType(draft, 'civil')).toBe(draft);
    expect(chooseWorkType(draft, 'installation').work).toEqual([]);
  });

  it('steps quantities with buttons and removes a line at zero', () => {
    let draft = chooseWorkType(startDraft(box), 'civil');
    draft = stepWork(draft, id(101), SELF, 10);
    draft = stepWork(draft, id(101), SELF, -1);
    expect(draft.work).toEqual([{ itemId: id(101), performer: SELF, quantity: '9' }]);
    expect(stepWork(draft, id(101), SELF, -10).work).toEqual([]);
    draft = stepMaterial(stepMaterial(draft, id(102), 10), id(102), -1);
    expect(draft.materials).toEqual({ [id(102)]: '9' });
    expect(stepMaterial(draft, id(102), -10).materials).toEqual({});
  });

  it('splits one work line between several performers, each with its own quantity', () => {
    let draft = chooseWorkType(startDraft(box), 'civil');
    draft = stepWork(draft, id(101), via(1), 20);
    draft = stepWork(draft, id(101), via(2), 30);
    draft = stepWork(draft, id(101), SELF, 50);
    expect(draft.work.map((line) => line.quantity)).toEqual(['20', '30', '50']);
    // The same performer is the same line, never a second one.
    draft = stepWork(draft, id(101), via(1), 1);
    expect(draft.work).toHaveLength(3);
    expect(workQuantity(draft, id(101), via(1))).toBe('21');
    expect(workQuantity(draft, id(101), via(3))).toBe('0');
    // Removing one performer keeps the others.
    draft = stepWork(draft, id(101), via(2), -30);
    expect(draft.work.map((line) => line.performer)).toEqual([via(1), SELF]);
  });

  it('sends the performer of each work line and none on material lines', () => {
    let draft = chooseWorkType(startDraft(box), 'civil');
    draft = stepWork(draft, id(101), via(1), 2);
    draft = stepWork(draft, id(101), SELF, 3);
    draft = stepMaterial(draft, id(102), 4);
    const op = buildRecordOp(
      { ...draft, gps: gpsAt(E, N), photos: [photo] },
      { clientOpId: id(900), capturedAt: '2026-10-30T10:00:00Z', designRevisionId: id(901) },
      [],
    );
    expect(op.payload.lines).toEqual([
      { workOrderItemId: id(101), quantity: '2', role: 'work', performer: via(1) },
      { workOrderItemId: id(101), quantity: '3', role: 'work', performer: SELF },
      { workOrderItemId: id(102), quantity: '4', role: 'material', performer: null },
    ]);
  });

  it('refuses the same performer twice on one work-order line', () => {
    const base = chooseWorkType(startDraft(box), 'civil');
    const duplicated: UpdateDraft = {
      ...base,
      work: [
        { itemId: id(101), performer: via(1), quantity: '1' },
        { itemId: id(101), performer: via(1), quantity: '2' },
      ],
    };
    expect(() =>
      buildRecordOp(
        duplicated,
        { clientOpId: id(900), capturedAt: '2026-10-30T10:00:00Z', designRevisionId: id(901) },
        [],
      ),
    ).toThrow();
  });

  describe('contractor quantity left (ADR-052)', () => {
    const withContractors = [
      { ...catalog[0], contractors: [contractorLine(1, '20', '15'), contractorLine(2, '50')] },
    ] as CatalogItem[];
    const draftWith = (performer: LinePerformer, quantity: string): UpdateDraft => ({
      ...chooseWorkType(startDraft(box), 'civil'),
      work: [{ itemId: id(101), performer, quantity }],
    });

    it('is the quantity minus the bundle record minus own unsent updates, never negative', () => {
      const c = contractorLine(1, '20', '15');
      expect(contractorLeft(c, {})).toBe('5');
      expect(contractorLeft(c, { [c.contractorLineId]: '3' })).toBe('2');
      expect(contractorLeft(c, { [c.contractorLineId]: '9' })).toBe('0');
    });

    it('blocks a quantity above what is left, and the step stays locked', () => {
      const ctx = { catalog: withContractors, unsyncedByContractorLine: {} };
      const over = draftWith(via(1), '6');
      expect(contractorOverruns(over, withContractors, {})).toMatchObject([
        { itemId: id(101), left: '5' },
      ]);
      expect(stepProblems(over, 'work', requirements, ctx)).toEqual([
        'CONTRACTOR_QUANTITY_EXCEEDED',
      ]);
      expect(goNext({ ...over, step: 'work' }, requirements, ctx).step).toBe('work');
      expect(
        stepProblems({ ...over, gps: null, photos: [photo] }, 'review', requirements, ctx),
      ).toContain('CONTRACTOR_QUANTITY_EXCEEDED');
      expect(contractorOverruns(draftWith(via(1), '5'), withContractors, {})).toEqual([]);
      // The company itself has no limit.
      expect(contractorOverruns(draftWith(SELF, '9999'), withContractors, {})).toEqual([]);
    });

    it('counts the own outbox, without rejected updates or those older than the bundle', () => {
      const entry = (
        state: OutboxEntry['state'],
        capturedAt: string,
        quantity: string,
      ): OutboxEntry => ({
        clientOpId: id(700),
        state,
        attempts: 0,
        updateId: null,
        rejection: null,
        op: {
          kind: 'execution_update.record',
          clientOpId: id(700),
          capturedAt,
          payload: {
            featureId: id(1),
            designRevisionId: id(2),
            workType: 'civil',
            lines: [
              { workOrderItemId: id(101), quantity, role: 'work', performer: via(1) },
              { workOrderItemId: id(101), quantity: '1', role: 'work', performer: SELF },
              { workOrderItemId: id(102), quantity: '1', role: 'material', performer: null },
            ],
            label: null,
            note: null,
            gps: null,
            photos: [],
            acknowledgedWarnings: [],
          },
        },
      });
      const since = '2026-10-30T08:00:00.000Z';
      const totals = unsyncedTotals(
        [
          entry('pending', '2026-10-30T09:00:00.000Z', '2'),
          entry('applied', '2026-10-30T09:30:00.000Z', '1'),
          entry('rejected', '2026-10-30T09:40:00.000Z', '100'),
          entry('pending', '2026-10-30T07:00:00.000Z', '100'),
        ],
        since,
      );
      expect(totals.byContractorLine).toEqual({ [id(301)]: '3' });
      expect(totals.byItem).toEqual({ [id(101)]: '5', [id(102)]: '2' });
      // 5 left - 3 recorded on this phone = 2: three is too much.
      expect(
        contractorOverruns(draftWith(via(1), '3'), withContractors, totals.byContractorLine),
      ).toHaveLength(1);
      expect(
        contractorOverruns(draftWith(via(1), '2'), withContractors, totals.byContractorLine),
      ).toHaveLength(0);
    });
  });

  it('uses the generic photo requirement until Phase 2 rules exist', () => {
    expect(requirements).toEqual([{ key: 'general', minCount: 1 }]);
    const withRules: Pick<OfflineBundle, 'settings'> = {
      settings: {
        ...settings.settings,
        photoRequirements: {
          status: 'available',
          byWorkType: {
            civil: [
              { key: 'before', minCount: 1 },
              { key: 'after', minCount: 2 },
            ],
          },
          fallback: [],
        },
      },
    };
    const rules = photoRequirementsFor(withRules, 'civil');
    const draft = { ...startDraft(box), photos: [{ ...photo, requirementKey: 'after' }] };
    expect(missingPhotos(draft, rules)).toEqual([
      { key: 'before', minCount: 1 },
      { key: 'after', minCount: 1 },
    ]);
  });

  it('warns about GPS distance beyond 50 m, missing GPS and overruns, including unsynced work', () => {
    const ctx = { crsEpsg: 32636, gpsWarningDistanceM: 50, catalog, unsyncedByItem: {} };
    const near = computeWarnings(complete(), ctx);
    expect(near.warnings).toEqual(['ITEM_OVERRUN']); // item 1: 9 recorded + 1 = 10 ok; item 2: 10 > 5
    expect(near.overrunItemIds).toEqual([id(102)]);
    expect(near.gpsDistanceM).toBeCloseTo(10, 3);

    const far = computeWarnings({ ...complete(), gps: gpsAt(E + 60, N) }, ctx);
    expect(far.warnings).toContain('GPS_FAR');
    expect(computeWarnings({ ...complete(), gps: null }, ctx).warnings).toContain(
      'GPS_UNAVAILABLE',
    );

    const unsynced = computeWarnings(complete(), {
      ...ctx,
      unsyncedByItem: { [id(101)]: '0.0001' },
    });
    expect(unsynced.overrunItemIds).toEqual([id(101), id(102)]);
  });

  it('saves only after every warning is acknowledged, and builds a valid operation', () => {
    const ctx = { crsEpsg: 32636, gpsWarningDistanceM: 50, catalog, unsyncedByItem: {} };
    let draft = complete();
    const { warnings } = computeWarnings(draft, ctx);
    expect(canSave(draft, requirements, warnings)).toBe(false);
    draft = acknowledge(draft, warnings);
    expect(canSave(draft, requirements, warnings)).toBe(true);
    expect(canSave({ ...draft, photos: [] }, requirements, warnings)).toBe(false);

    const op = buildRecordOp(
      { ...draft, note: '  حفر يدوي  ', label: ' ' },
      { clientOpId: id(900), capturedAt: '2026-10-30T10:00:00+02:00', designRevisionId: id(901) },
      warnings,
    );
    expect(op.payload.lines).toEqual([
      { workOrderItemId: id(101), quantity: '1', role: 'work', performer: SELF },
      { workOrderItemId: id(102), quantity: '10', role: 'material', performer: null },
    ]);
    expect(op.payload.note).toBe('حفر يدوي');
    expect(op.payload.label).toBeNull();
    expect(op.payload.acknowledgedWarnings).toEqual(['ITEM_OVERRUN']);
    expect(() =>
      buildRecordOp(
        startDraft(box),
        { clientOpId: id(1), capturedAt: '2026-10-30T10:00:00Z', designRevisionId: id(2) },
        [],
      ),
    ).toThrow('No activity chosen');
  });
});
