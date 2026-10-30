import { createProjectCrs } from '@ftth/geo';
import {
  RecordUpdateOpSchema,
  type CatalogItem,
  type ClientWarning,
  type GpsFix,
  type OfflineBundle,
  type OfflineFeature,
  type PhotoRequirement,
  type RecordUpdateOp,
  type UpdateLineRole,
  type WorkType,
} from '@ftth/shared';
import { distanceToFeature } from '../../cad/model/viewport';
import {
  addQuantities,
  compareQuantities,
  isZeroQuantity,
  stepQuantity,
} from '../../../shared/model/quantity';

/**
 * The 6 fixed steps of the update tool (plan, "مبادئ UI/UX"):
 * activity › work items › materials › label & location › photos › review.
 */
export const UPDATE_STEPS = [
  'activity',
  'work',
  'materials',
  'location',
  'photos',
  'review',
] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

export interface CapturedPhoto {
  photoId: string;
  requirementKey: string;
  fileUri: string;
  sha256: string;
  sizeBytes: number;
  takenAt: string;
  gps: GpsFix | null;
}

export interface UpdateDraft {
  feature: OfflineFeature;
  step: UpdateStep;
  workType: WorkType | null;
  /** itemId → quantity (decimal string) per step. */
  work: Readonly<Record<string, string>>;
  materials: Readonly<Record<string, string>>;
  label: string;
  note: string;
  gps: GpsFix | null;
  photos: readonly CapturedPhoto[];
  /** Warnings the supervisor has seen and accepted on the review step. */
  acknowledged: readonly ClientWarning[];
}

export function startDraft(feature: OfflineFeature): UpdateDraft {
  return {
    feature,
    step: 'activity',
    workType: null,
    work: {},
    materials: {},
    label: feature.code ?? '',
    note: '',
    gps: null,
    photos: [],
    acknowledged: [],
  };
}

const lineKey = (role: UpdateLineRole): 'work' | 'materials' =>
  role === 'work' ? 'work' : 'materials';

export function chooseWorkType(draft: UpdateDraft, workType: WorkType): UpdateDraft {
  // Changing the activity drops lines of the previous one: items belong to one work type.
  if (draft.workType === workType) return draft;
  return { ...draft, workType, work: {}, materials: {} };
}

/** Stepper buttons (no keyboard for numbers, plan): ±1 or ±10 whole units. */
export function stepLine(
  draft: UpdateDraft,
  role: UpdateLineRole,
  itemId: string,
  delta: number,
): UpdateDraft {
  const key = lineKey(role);
  const next = stepQuantity(draft[key][itemId] ?? '0', delta);
  const others = Object.entries(draft[key]).filter(([id]) => id !== itemId);
  const lines = Object.fromEntries(isZeroQuantity(next) ? others : [...others, [itemId, next]]);
  return { ...draft, [key]: lines };
}

/**
 * Items offered in steps 2 and 3: the project's work-order items of the chosen activity. Phase 2
 * will narrow them by feature type (`type_rules`) and split work from materials (BOQ kind);
 * until then both steps offer the same list (ADR-023).
 */
export function itemsForActivity(
  catalog: readonly CatalogItem[],
  workType: WorkType | null,
): CatalogItem[] {
  if (!workType) return [];
  return catalog.filter((item) => item.workType === workType);
}

export function photoRequirementsFor(
  bundle: Pick<OfflineBundle, 'settings'>,
  workType: WorkType | null,
): PhotoRequirement[] {
  const rules = bundle.settings.photoRequirements;
  if (rules.status === 'available' && workType && rules.byWorkType[workType]) {
    return rules.byWorkType[workType] ?? [];
  }
  return rules.fallback;
}

export function missingPhotos(
  draft: UpdateDraft,
  requirements: readonly PhotoRequirement[],
): PhotoRequirement[] {
  return requirements
    .map((requirement) => ({
      key: requirement.key,
      minCount:
        requirement.minCount -
        draft.photos.filter((photo) => photo.requirementKey === requirement.key).length,
    }))
    .filter((requirement) => requirement.minCount > 0);
}

export type StepProblem =
  'NO_ACTIVITY' | 'NO_LINES' | 'LABEL_TOO_LONG' | 'NOTE_TOO_LONG' | 'PHOTOS_MISSING';

/** What blocks leaving `step` (save stays locked until mandatory photos are complete, plan). */
export function stepProblems(
  draft: UpdateDraft,
  step: UpdateStep,
  requirements: readonly PhotoRequirement[],
): StepProblem[] {
  switch (step) {
    case 'activity':
      return draft.workType ? [] : ['NO_ACTIVITY'];
    case 'work':
    case 'materials':
      // Either step may be empty, not both: an update records at least one line.
      return step === 'materials' &&
        Object.keys(draft.work).length + Object.keys(draft.materials).length === 0
        ? ['NO_LINES']
        : [];
    case 'location': {
      const problems: StepProblem[] = [];
      if (draft.label.trim().length > 200) problems.push('LABEL_TOO_LONG');
      if (draft.note.trim().length > 2000) problems.push('NOTE_TOO_LONG');
      return problems;
    }
    case 'photos':
      return missingPhotos(draft, requirements).length > 0 ? ['PHOTOS_MISSING'] : [];
    case 'review':
      return UPDATE_STEPS.slice(0, -1).flatMap((earlier) =>
        stepProblems(draft, earlier, requirements),
      );
  }
}

export function goNext(draft: UpdateDraft, requirements: readonly PhotoRequirement[]): UpdateDraft {
  if (stepProblems(draft, draft.step, requirements).length > 0) return draft;
  const index = UPDATE_STEPS.indexOf(draft.step);
  return { ...draft, step: UPDATE_STEPS[Math.min(index + 1, UPDATE_STEPS.length - 1)] ?? 'review' };
}

/** Every step has a way back (plan). */
export function goBack(draft: UpdateDraft): UpdateDraft {
  const index = UPDATE_STEPS.indexOf(draft.step);
  return { ...draft, step: UPDATE_STEPS[Math.max(index - 1, 0)] ?? 'activity' };
}

export interface WarningContext {
  crsEpsg: number;
  gpsWarningDistanceM: number;
  catalog: readonly CatalogItem[];
  /** Quantities this device recorded but the server does not count yet (outbox), per item. */
  unsyncedByItem: Readonly<Record<string, string>>;
}

export interface UpdateWarnings {
  /** Metres from the GPS fix to the feature, or null without a fix. */
  gpsDistanceM: number | null;
  warnings: ClientWarning[];
  /** Items whose recorded quantity would exceed the work-order quantity. */
  overrunItemIds: string[];
}

/**
 * Warnings, never blocks (plan: "منع الأخطاء مش رفضها"): GPS farther than the configured
 * distance from the feature, no GPS fix, or more than the work-order quantity recorded.
 */
export function computeWarnings(draft: UpdateDraft, ctx: WarningContext): UpdateWarnings {
  const warnings: ClientWarning[] = [];
  let gpsDistanceM: number | null = null;
  if (draft.gps) {
    const projected = createProjectCrs(ctx.crsEpsg).fromWgs84({
      lon: draft.gps.lon,
      lat: draft.gps.lat,
    });
    gpsDistanceM = distanceToFeature(draft.feature, projected);
    if (gpsDistanceM > ctx.gpsWarningDistanceM) warnings.push('GPS_FAR');
  } else {
    warnings.push('GPS_UNAVAILABLE');
  }

  const totals = new Map<string, string>();
  for (const lines of [draft.work, draft.materials]) {
    for (const [itemId, quantity] of Object.entries(lines)) {
      totals.set(itemId, addQuantities(totals.get(itemId) ?? '0', quantity));
    }
  }
  const overrunItemIds: string[] = [];
  for (const [itemId, quantity] of totals) {
    const item = ctx.catalog.find((candidate) => candidate.id === itemId);
    if (!item) continue;
    const after = addQuantities(item.recordedQuantity, ctx.unsyncedByItem[itemId] ?? '0', quantity);
    if (compareQuantities(after, item.quantity) > 0) overrunItemIds.push(itemId);
  }
  if (overrunItemIds.length > 0) warnings.push('ITEM_OVERRUN');
  return { gpsDistanceM, warnings, overrunItemIds };
}

export function acknowledge(draft: UpdateDraft, warnings: readonly ClientWarning[]): UpdateDraft {
  return { ...draft, acknowledged: [...new Set([...draft.acknowledged, ...warnings])] };
}

/** True when every current warning has been accepted on the review step. */
export function canSave(
  draft: UpdateDraft,
  requirements: readonly PhotoRequirement[],
  warnings: readonly ClientWarning[],
): boolean {
  return (
    stepProblems(draft, 'review', requirements).length === 0 &&
    warnings.every((warning) => draft.acknowledged.includes(warning))
  );
}

/** The outbox operation for a finished draft, validated with the shared contract. */
export function buildRecordOp(
  draft: UpdateDraft,
  input: { clientOpId: string; capturedAt: string; designRevisionId: string },
  warnings: readonly ClientWarning[],
): RecordUpdateOp {
  if (!draft.workType) throw new Error('No activity chosen');
  const lines = [
    ...Object.entries(draft.work).map(([workOrderItemId, quantity]) => ({
      workOrderItemId,
      quantity,
      role: 'work' as const,
    })),
    ...Object.entries(draft.materials).map(([workOrderItemId, quantity]) => ({
      workOrderItemId,
      quantity,
      role: 'material' as const,
    })),
  ];
  const label = draft.label.trim();
  const note = draft.note.trim();
  return RecordUpdateOpSchema.parse({
    kind: 'execution_update.record',
    clientOpId: input.clientOpId,
    capturedAt: input.capturedAt,
    payload: {
      featureId: draft.feature.id,
      designRevisionId: input.designRevisionId,
      workType: draft.workType,
      lines,
      label: label === '' ? null : label,
      note: note === '' ? null : note,
      gps: draft.gps,
      photos: draft.photos.map((photo) => ({
        photoId: photo.photoId,
        requirementKey: photo.requirementKey,
        sha256: photo.sha256,
        sizeBytes: photo.sizeBytes,
        contentType: 'image/jpeg',
        takenAt: photo.takenAt,
        gps: photo.gps,
      })),
      acknowledgedWarnings: draft.acknowledged.filter((warning) => warnings.includes(warning)),
    },
  });
}
