import { createProjectCrs } from '@ftth/geo';
import {
  LineDimensionsSchema,
  RecordUpdateOpSchema,
  elementKeyOf,
  groupsForElement,
  performerKeyOf,
  volumeOf,
  type DrawingKind,
  type ElementKey,
  type GroupedLines,
  type LineDimensions,
  type CatalogContractor,
  type CatalogItem,
  type ClientWarning,
  type GpsFix,
  type LinePerformer,
  type OfflineBundle,
  type OfflineFeature,
  type PhotoRequirement,
  type RecordUpdateOp,
  type WorkType,
} from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';
import { distanceToFeature } from '../../cad/model/viewport';
import {
  addQuantities,
  compareQuantities,
  isZeroQuantity,
  remainingQuantity,
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

export interface WorkLine {
  itemId: string;
  performer: LinePerformer;
  /** Decimal string, never zero (a zero line is removed). */
  quantity: string;
  /** ADR-056: typed length × width × depth of a digging line; then `quantity` is their volume. */
  dimensions?: LineDimensions | null;
}

export const SELF_PERFORMER: LinePerformer = { kind: 'self' };

/**
 * What the update is recorded on: a tapped element, or the «التخطيط» button of a drawing (ADR-056)
 * which has no element.
 */
export type UpdateTarget =
  { kind: 'feature'; feature: OfflineFeature } | { kind: 'planning'; drawingId: string };

export interface UpdateDraft {
  target: UpdateTarget;
  step: UpdateStep;
  workType: WorkType | null;
  /**
   * Work lines (ADR-052): one per work-order item and performer, so one item may be split between
   * contractors and the company itself. A performer appears once per item.
   */
  work: readonly WorkLine[];
  /** itemId → quantity (decimal string); material lines carry no performer. */
  materials: Readonly<Record<string, string>>;
  label: string;
  note: string;
  gps: GpsFix | null;
  photos: readonly CapturedPhoto[];
  /** Warnings the supervisor has seen and accepted on the review step. */
  acknowledged: readonly ClientWarning[];
}

const emptyDraft = (target: UpdateTarget): UpdateDraft => ({
  target,
  step: 'activity',
  workType: null,
  work: [],
  materials: {},
  label: '',
  note: '',
  gps: null,
  photos: [],
  acknowledged: [],
});

export function startDraft(feature: OfflineFeature): UpdateDraft {
  return { ...emptyDraft({ kind: 'feature', feature }), label: feature.code ?? '' };
}

/**
 * «التخطيط» (ADR-056): no element, so no label to default and no GPS distance. The activity is
 * planning already, so the supervisor starts at the work step (back still reaches the activity).
 */
export function startPlanningDraft(drawingId: string): UpdateDraft {
  return {
    ...emptyDraft({ kind: 'planning', drawingId }),
    step: 'work',
    workType: 'planning',
  };
}

/** The tapped element of the draft; null for a «التخطيط» update. */
export const featureOf = (draft: Pick<UpdateDraft, 'target'>): OfflineFeature | null =>
  draft.target.kind === 'feature' ? draft.target.feature : null;

/** The kind of the drawing the bundle shows; General when the server does not say (older bundle). */
export function currentDrawingKind(
  bundle: Pick<OfflineBundle, 'drawings' | 'revision'>,
): DrawingKind {
  const drawingId = bundle.revision?.drawingId;
  return bundle.drawings.find((d) => d.drawingId === drawingId)?.kind ?? 'general';
}

/** The element whose main groups the supervisor sees (ADR-056). */
export function elementOfDraft(draft: Pick<UpdateDraft, 'target'>, kind: DrawingKind): ElementKey {
  return draft.target.kind === 'planning'
    ? 'planning'
    : elementKeyOf(draft.target.feature.type, kind);
}

export function chooseWorkType(draft: UpdateDraft, workType: WorkType): UpdateDraft {
  // Changing the activity drops lines of the previous one: items belong to one work type.
  if (draft.workType === workType) return draft;
  return { ...draft, workType, work: [], materials: {} };
}

/** Stepper buttons on a material line (no keyboard for numbers, plan): ±1 or ±10 whole units. */
export function stepMaterial(draft: UpdateDraft, itemId: string, delta: number): UpdateDraft {
  const next = stepQuantity(draft.materials[itemId] ?? '0', delta);
  const others = Object.entries(draft.materials).filter(([id]) => id !== itemId);
  return {
    ...draft,
    materials: Object.fromEntries(isZeroQuantity(next) ? others : [...others, [itemId, next]]),
  };
}

const isLine = (line: WorkLine, itemId: string, performer: LinePerformer): boolean =>
  line.itemId === itemId && performerKeyOf(line.performer) === performerKeyOf(performer);

export const workQuantity = (
  draft: Pick<UpdateDraft, 'work'>,
  itemId: string,
  performer: LinePerformer,
): string => draft.work.find((line) => isLine(line, itemId, performer))?.quantity ?? '0';

/**
 * Stepper buttons on a work line of one performer. The same performer on the same item is one
 * line (a performer appears once per work-order line); another performer adds another line.
 */
export function stepWork(
  draft: UpdateDraft,
  itemId: string,
  performer: LinePerformer,
  delta: number,
): UpdateDraft {
  // A dimensioned line takes its quantity from L × W × D, never from the stepper.
  if (draft.work.find((line) => isLine(line, itemId, performer))?.dimensions) return draft;
  const next = stepQuantity(workQuantity(draft, itemId, performer), delta);
  const work = draft.work.some((line) => isLine(line, itemId, performer))
    ? draft.work.map((line) =>
        isLine(line, itemId, performer) ? { ...line, quantity: next } : line,
      )
    : [...draft.work, { itemId, performer, quantity: next }];
  return { ...draft, work: work.filter((line) => !isZeroQuantity(line.quantity)) };
}

export const dimensionsOf = (
  draft: Pick<UpdateDraft, 'work'>,
  itemId: string,
  performer: LinePerformer,
): LineDimensions | null =>
  draft.work.find((line) => isLine(line, itemId, performer))?.dimensions ?? null;

/** The three typed texts of a digging line (metres). */
export interface DimensionTexts {
  lengthM: string;
  widthM: string;
  depthM: string;
}

/** Accepts Arabic-Indic digits and the Arabic or comma decimal mark a phone keypad may type. */
export function normalizeDecimalText(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,،]/g, '.')
    .replace(/\s+/g, '');
}

/** The typed texts as dimensions, or null while any is empty, malformed, zero or over 4 decimals. */
export function parseDimensions(texts: DimensionTexts): LineDimensions | null {
  const parsed = LineDimensionsSchema.safeParse({
    lengthM: normalizeDecimalText(texts.lengthM),
    widthM: normalizeDecimalText(texts.widthM),
    depthM: normalizeDecimalText(texts.depthM),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Sets (or with null clears) the dimensions of a line of one performer; the quantity is their
 * product, never typed. One dimension set per line and performer: editing replaces it.
 */
export function setWorkDimensions(
  draft: UpdateDraft,
  itemId: string,
  performer: LinePerformer,
  dimensions: LineDimensions | null,
): UpdateDraft {
  const others = draft.work.filter((line) => !isLine(line, itemId, performer));
  if (!dimensions) return { ...draft, work: others };
  const quantity = volumeOf(dimensions);
  if (isZeroQuantity(quantity)) return { ...draft, work: others };
  const existing = draft.work.findIndex((line) => isLine(line, itemId, performer));
  const line: WorkLine = { itemId, performer, quantity, dimensions };
  const work =
    existing === -1
      ? [...others, line]
      : draft.work.map((current, index) => (index === existing ? line : current));
  return { ...draft, work };
}

/** Total typed on one item (all performers and materials), '0' when nothing. */
export function enteredQuantity(draft: UpdateDraft, itemId: string): string {
  return addQuantities(
    draft.materials[itemId] ?? '0',
    ...draft.work.filter((line) => line.itemId === itemId).map((line) => line.quantity),
  );
}

// ---------- group navigation (ADR-056) ----------

/** Where the supervisor is in element › main group › sub group; both null at the first level. */
export interface GroupPath {
  main: string | null;
  sub: string | null;
}

export const ROOT_PATH: GroupPath = { main: null, sub: null };

export type GroupView =
  | { level: 'main'; mains: { name: string; lines: CatalogItem[] }[] }
  | {
      level: 'sub';
      main: string;
      subs: { name: string; lines: CatalogItem[] }[];
      /** Lines of the main group with no sub group, shown directly. */
      direct: CatalogItem[];
    }
  | { level: 'lines'; main: string; sub: string; lines: CatalogItem[] };

/** An older server sends no map: keep the flat list as before. */
export const usesGroups = (bundle: Pick<OfflineBundle, 'elementGroups'>): boolean =>
  bundle.elementGroups.length > 0;

/** The groups the device offers under an element (ADR-056), lines narrowed by the activity. */
export function groupedLinesFor(
  bundle: Pick<OfflineBundle, 'elementGroups'>,
  element: ElementKey,
  items: readonly CatalogItem[],
): GroupedLines<CatalogItem>[] {
  return groupsForElement(bundle.elementGroups, element, items);
}

export function groupView(
  groups: readonly GroupedLines<CatalogItem>[],
  path: GroupPath,
): GroupView {
  const main = path.main === null ? undefined : groups.find((g) => g.main === path.main);
  if (!main) {
    return {
      level: 'main',
      mains: groups.map((g) => ({ name: g.main, lines: g.subs.flatMap((s) => s.items) })),
    };
  }
  const sub = path.sub === null ? undefined : main.subs.find((s) => s.sub === path.sub);
  if (sub && sub.sub !== null) {
    return { level: 'lines', main: main.main, sub: sub.sub, lines: sub.items };
  }
  return {
    level: 'sub',
    main: main.main,
    subs: main.subs.flatMap((s) => (s.sub === null ? [] : [{ name: s.sub, lines: s.items }])),
    direct: main.subs.find((s) => s.sub === null)?.items ?? [],
  };
}

export const openMain = (main: string): GroupPath => ({ main, sub: null });
export const openSub = (path: GroupPath, sub: string): GroupPath => ({ main: path.main, sub });

/** One level up; the root stays the root. */
export function groupBack(path: GroupPath): GroupPath {
  return path.sub !== null ? { main: path.main, sub: null } : ROOT_PATH;
}

/** Quantity left of a contractor line on this phone: bundle numbers minus the own unsent updates. */
export function contractorLeft(
  contractor: Pick<CatalogContractor, 'quantity' | 'recordedQuantity' | 'contractorLineId'>,
  unsyncedByContractorLine: Readonly<Record<string, string>>,
): string {
  return remainingQuantity(
    contractor.quantity,
    contractor.recordedQuantity,
    unsyncedByContractorLine[contractor.contractorLineId] ?? '0',
  );
}

export interface ContractorOverrun {
  itemId: string;
  contractor: CatalogContractor;
  left: string;
}

/** Contractor lines whose typed quantity is above what is left of them (saving is blocked). */
export function contractorOverruns(
  draft: Pick<UpdateDraft, 'work'>,
  catalog: readonly CatalogItem[],
  unsyncedByContractorLine: Readonly<Record<string, string>>,
): ContractorOverrun[] {
  return draft.work.flatMap((line): ContractorOverrun[] => {
    if (line.performer.kind !== 'contractor') return [];
    const lineId = line.performer.contractorLineId;
    const contractor = catalog
      .find((item) => item.id === line.itemId)
      ?.contractors.find((candidate) => candidate.contractorLineId === lineId);
    // A contractor line the bundle does not know cannot be checked here; the server decides.
    if (!contractor) return [];
    const left = contractorLeft(contractor, unsyncedByContractorLine);
    return compareQuantities(line.quantity, left) > 0
      ? [{ itemId: line.itemId, contractor, left }]
      : [];
  });
}

/**
 * What this device recorded since the bundle was built and the server does not count yet (outbox):
 * per item, and per contractor line (work lines only).
 */
export function unsyncedTotals(
  entries: readonly OutboxEntry[],
  since: string,
): { byItem: Record<string, string>; byContractorLine: Record<string, string> } {
  const byItem: Record<string, string> = {};
  const byContractorLine: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.op.kind !== 'execution_update.record') continue;
    if (entry.state === 'rejected' || entry.op.capturedAt < since) continue;
    for (const line of entry.op.payload.lines) {
      byItem[line.workOrderItemId] = addQuantities(
        byItem[line.workOrderItemId] ?? '0',
        line.quantity,
      );
      if (line.performer?.kind === 'contractor') {
        const id = line.performer.contractorLineId;
        byContractorLine[id] = addQuantities(byContractorLine[id] ?? '0', line.quantity);
      }
    }
  }
  return { byItem, byContractorLine };
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
  | 'NO_ACTIVITY'
  | 'NO_LINES'
  | 'LABEL_TOO_LONG'
  | 'NOTE_TOO_LONG'
  | 'PHOTOS_MISSING'
  | 'CONTRACTOR_QUANTITY_EXCEEDED';

/** What the phone knows about contractor quantities (for the block of ADR-052). */
export interface ContractorContext {
  catalog: readonly CatalogItem[];
  unsyncedByContractorLine: Readonly<Record<string, string>>;
}

/** What blocks leaving `step` (save stays locked until mandatory photos are complete, plan). */
export function stepProblems(
  draft: UpdateDraft,
  step: UpdateStep,
  requirements: readonly PhotoRequirement[],
  contractors?: ContractorContext,
): StepProblem[] {
  switch (step) {
    case 'activity':
      return draft.workType ? [] : ['NO_ACTIVITY'];
    case 'work':
      return contractors &&
        contractorOverruns(draft, contractors.catalog, contractors.unsyncedByContractorLine)
          .length > 0
        ? ['CONTRACTOR_QUANTITY_EXCEEDED']
        : [];
    case 'materials':
      // Either step may be empty, not both: an update records at least one line.
      return draft.work.length + Object.keys(draft.materials).length === 0 ? ['NO_LINES'] : [];
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
        stepProblems(draft, earlier, requirements, contractors),
      );
  }
}

export function goNext(
  draft: UpdateDraft,
  requirements: readonly PhotoRequirement[],
  contractors?: ContractorContext,
): UpdateDraft {
  if (stepProblems(draft, draft.step, requirements, contractors).length > 0) return draft;
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
  const feature = featureOf(draft);
  if (feature === null) {
    // «التخطيط» (ADR-056): there is no element to be far from; only a missing fix is reported.
    if (!draft.gps) warnings.push('GPS_UNAVAILABLE');
  } else if (draft.gps) {
    const projected = createProjectCrs(ctx.crsEpsg).fromWgs84({
      lon: draft.gps.lon,
      lat: draft.gps.lat,
    });
    gpsDistanceM = distanceToFeature(feature, projected);
    if (gpsDistanceM > ctx.gpsWarningDistanceM) warnings.push('GPS_FAR');
  } else {
    warnings.push('GPS_UNAVAILABLE');
  }

  const totals = new Map<string, string>();
  const recorded = [
    ...draft.work.map((line) => [line.itemId, line.quantity] as const),
    ...Object.entries(draft.materials),
  ];
  for (const [itemId, quantity] of recorded) {
    totals.set(itemId, addQuantities(totals.get(itemId) ?? '0', quantity));
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
  contractors?: ContractorContext,
): boolean {
  return (
    stepProblems(draft, 'review', requirements, contractors).length === 0 &&
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
    ...draft.work.map((line) => ({
      workOrderItemId: line.itemId,
      quantity: line.quantity,
      role: 'work' as const,
      performer: line.performer,
      dimensions: line.dimensions ?? null,
    })),
    ...Object.entries(draft.materials).map(([workOrderItemId, quantity]) => ({
      workOrderItemId,
      quantity,
      role: 'material' as const,
      performer: null,
      dimensions: null,
    })),
  ];
  const label = draft.label.trim();
  const note = draft.note.trim();
  return RecordUpdateOpSchema.parse({
    kind: 'execution_update.record',
    clientOpId: input.clientOpId,
    capturedAt: input.capturedAt,
    payload: {
      featureId: featureOf(draft)?.id ?? null,
      drawingId: draft.target.kind === 'planning' ? draft.target.drawingId : null,
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
