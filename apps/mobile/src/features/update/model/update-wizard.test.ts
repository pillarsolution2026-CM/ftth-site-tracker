import { createProjectCrs } from '@ftth/geo';
import type { CatalogItem, OfflineBundle, OfflineFeature } from '@ftth/shared';
import {
  acknowledge,
  buildRecordOp,
  canSave,
  chooseWorkType,
  computeWarnings,
  goBack,
  goNext,
  itemsForActivity,
  missingPhotos,
  photoRequirementsFor,
  startDraft,
  stepLine,
  stepProblems,
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
});
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
  draft = stepLine(draft, 'work', id(101), 1);
  draft = stepLine(draft, 'material', id(102), 10);
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
    draft = goNext(stepLine(draft, 'material', id(102), 1), requirements);
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
    const draft = stepLine(chooseWorkType(startDraft(box), 'civil'), 'work', id(101), 1);
    expect(chooseWorkType(draft, 'civil')).toBe(draft);
    expect(chooseWorkType(draft, 'installation').work).toEqual({});
  });

  it('steps quantities with buttons and removes a line at zero', () => {
    let draft = chooseWorkType(startDraft(box), 'civil');
    draft = stepLine(draft, 'work', id(101), 10);
    draft = stepLine(draft, 'work', id(101), -1);
    expect(draft.work).toEqual({ [id(101)]: '9' });
    expect(stepLine(draft, 'work', id(101), -10).work).toEqual({});
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
      { workOrderItemId: id(101), quantity: '1', role: 'work' },
      { workOrderItemId: id(102), quantity: '10', role: 'material' },
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
