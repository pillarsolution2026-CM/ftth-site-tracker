import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import {
  WORK_TYPES,
  performerKeyOf,
  shiftDay,
  workDayOf,
  type CatalogItem,
  type GpsFix,
  type ElementKey,
  type GroupedLines,
  type LineDimensions,
  type LinePerformer,
} from '@ftth/shared';
import { minTouchTarget, radius, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import { isZeroQuantity } from '../../../shared/model/quantity';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { useTheme } from '../../../shared/ui/theme';
import type { CaptureRequest } from '../../camera/hooks/usePhotoCapture';
import { useField } from '../../sync/hooks/FieldProvider';
import {
  acknowledge,
  buildRecordOp,
  canSave,
  chooseWorkType,
  computeWarnings,
  contractorLeft,
  contractorOverruns,
  currentDrawingKind,
  dimensionsOf,
  elementOfDraft,
  enteredQuantity,
  featureOf,
  goBack,
  goNext,
  groupBack,
  groupedLinesFor,
  groupView,
  itemsForActivity,
  missingPhotos,
  openMain,
  openSub,
  parseDimensions,
  registeredBy,
  setWorkDate,
  photoRequirementsFor,
  ROOT_PATH,
  setWorkDimensions,
  startDraft,
  startPlanningDraft,
  SELF_PERFORMER,
  stepMaterial,
  stepProblems,
  stepWork,
  unsyncedTotals,
  UPDATE_STEPS,
  usesGroups,
  workDateOf,
  workQuantity,
  type CapturedPhoto,
  type GroupPath,
  type UpdateDraft,
  type UpdateTarget,
} from '../model/update-wizard';

export interface UpdateWizardDeps {
  capturePhoto(request: CaptureRequest): Promise<CapturedPhoto | null>;
  locate(): Promise<GpsFix | null>;
  newId(): string;
  now(): Date;
  author: string;
}

interface UpdateWizardScreenProps {
  /** A tapped element, or the «التخطيط» button of a drawing (ADR-056). */
  target: UpdateTarget;
  deps: UpdateWizardDeps;
  onDone: () => void;
  onCancel: () => void;
}

/** The «تحديث» tool in 6 fixed steps with a progress bar and a way back on every step (plan). */
export function UpdateWizardScreen({ target, deps, onDone, onCancel }: UpdateWizardScreenProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const { bundle, entries, record } = useField();
  const [draft, setDraft] = useState<UpdateDraft>(() =>
    target.kind === 'feature' ? startDraft(target.feature) : startPlanningDraft(target.drawingId),
  );
  const feature = featureOf(draft);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  // ADR-057: a typed work date that is not valid yet blocks the work step; a date change that
  // drops contractor lines says so.
  const [dateInvalid, setDateInvalid] = useState(false);
  const [droppedLines, setDroppedLines] = useState(false);

  const locate = () => {
    setLocating(true);
    void deps
      .locate()
      .then((gps) => setDraft((d) => ({ ...d, gps })))
      .finally(() => setLocating(false));
  };
  // One fix when the tool opens; the location step can ask again.
  useEffect(locate, []);

  const requirements = useMemo(
    () => (bundle ? photoRequirementsFor(bundle, draft.workType) : []),
    [bundle, draft.workType],
  );
  // Lines the server did not count yet when the bundle was built.
  const unsynced = useMemo(
    () => unsyncedTotals(entries, bundle?.serverTime ?? ''),
    [bundle, entries],
  );
  const unsyncedByItem = unsynced.byItem;

  if (!bundle || !bundle.revision) return null;
  const warnings = computeWarnings(draft, {
    crsEpsg: bundle.project.crsEpsg,
    gpsWarningDistanceM: bundle.settings.gpsWarningDistanceM,
    catalog: bundle.catalog,
    unsyncedByItem,
  });
  const stepIndex = UPDATE_STEPS.indexOf(draft.step);
  // ADR-057: today in Cairo; the work date is today or earlier.
  const today = workDayOf(deps.now());
  const workDate = workDateOf(draft, today);
  const contractorContext = {
    catalog: bundle.catalog,
    unsyncedByContractorLine: unsynced.byContractorLine,
    today,
  };
  const problems = stepProblems(draft, draft.step, requirements, contractorContext);
  const overruns = contractorOverruns(draft, bundle.catalog, unsynced.byContractorLine);
  const items = itemsForActivity(bundle.catalog, draft.workType);
  const revisionId = bundle.revision.id;

  const save = async () => {
    setBusy(true);
    try {
      const op = buildRecordOp(
        draft,
        {
          clientOpId: deps.newId(),
          capturedAt: deps.now().toISOString(),
          designRevisionId: revisionId,
        },
        warnings.warnings,
      );
      await record(
        op,
        draft.photos.map((photo) => ({
          photoId: photo.photoId,
          fileUri: photo.fileUri,
          sizeBytes: photo.sizeBytes,
        })),
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const takePhoto = async (requirementKey: string) => {
    setBusy(true);
    try {
      const photo = await deps.capturePhoto({
        requirementKey,
        gps: draft.gps,
        watermark: {
          featureCode: feature?.code ?? null,
          featureType: feature?.type ?? 'planning',
          author: deps.author,
        },
      });
      if (photo) setDraft((d) => ({ ...d, photos: [...d.photos, photo] }));
    } finally {
      setBusy(false);
    }
  };

  // ADR-056: under groups the lines are reached element › main group › sub group; an older
  // server sends no map and keeps the flat list.
  const element = elementOfDraft(draft, currentDrawingKind(bundle));
  const groups = usesGroups(bundle) ? groupedLinesFor(bundle, element, items) : null;

  const itemsView = (step: 'work' | 'materials', renderItem: (item: CatalogItem) => ReactNode) =>
    groups ? (
      <GroupedItems
        key={step}
        element={element}
        groups={groups}
        draft={draft}
        renderItem={renderItem}
      />
    ) : items.length === 0 ? (
      <Text style={{ color: theme.text }}>{t('field.update.noItems')}</Text>
    ) : (
      items.map(renderItem)
    );

  const workList = () =>
    itemsView('work', (item) => (
      <WorkItemCard
        key={`work-${item.id}`}
        item={item}
        draft={draft}
        workDate={workDate}
        unsyncedByContractorLine={unsynced.byContractorLine}
        overrun={warnings.overrunItemIds.includes(item.id)}
        draftTotal={enteredQuantity(draft, item.id)}
        onStep={(performer, delta) => setDraft((d) => stepWork(d, item.id, performer, delta))}
        onDimensions={(performer, dimensions) =>
          setDraft((d) => setWorkDimensions(d, item.id, performer, dimensions))
        }
      />
    ));

  const materialList = () =>
    itemsView('materials', (item) => (
      <ItemCard
        key={`material-${item.id}`}
        item={item}
        overrun={warnings.overrunItemIds.includes(item.id)}
        draftTotal={enteredQuantity(draft, item.id)}
      >
        <Stepper
          quantity={draft.materials[item.id] ?? '0'}
          onStep={(delta) => setDraft((d) => stepMaterial(d, item.id, delta))}
          idPrefix={`material-${item.code}`}
        />
      </ItemCard>
    ));

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>
          {feature
            ? `${t(`featureType.${feature.type}`)} ${feature.code ? ltr(feature.code) : ''}`
            : t('field.update.groups.planning')}
        </Text>
        <Text style={{ color: theme.text }} testID="step-indicator">
          {t('field.update.stepOf', {
            current: ltr(stepIndex + 1),
            total: ltr(UPDATE_STEPS.length),
          })}{' '}
          — {t(`field.steps.${draft.step}`)}
        </Text>
        <View style={[styles.progressTrack, { borderColor: theme.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: theme.brand,
                width: `${((stepIndex + 1) / UPDATE_STEPS.length) * 100}%`,
              },
            ]}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {draft.step === 'activity'
          ? WORK_TYPES.map((workType) => (
              <Choice
                key={workType}
                label={t(`items.workTypes.${workType}`)}
                selected={draft.workType === workType}
                onPress={() => setDraft((d) => chooseWorkType(d, workType))}
                testID={`activity-${workType}`}
              />
            ))
          : null}
        {draft.step === 'work' || draft.step === 'materials' ? (
          <>
            {draft.step === 'work' ? (
              <WorkDateBar
                workDate={workDate}
                today={today}
                onInvalid={setDateInvalid}
                onPick={(day) => {
                  const next = setWorkDate(draft, day, today, bundle.catalog);
                  setDroppedLines(next.work.length < draft.work.length);
                  setDraft(next);
                }}
              />
            ) : null}
            {draft.step === 'work' && droppedLines ? (
              <Notice text={t('field.update.workDate.dropped')} />
            ) : null}
            <Notice text={t('field.update.phase2Items')} />
            <Notice text={t('field.update.suggestedUnavailable')} />
            {draft.step === 'work' ? workList() : materialList()}
          </>
        ) : null}
        {draft.step === 'location' ? (
          <>
            <Text style={[styles.label, { color: theme.text }]}>{t('field.update.label')}</Text>
            <TextInput
              value={draft.label}
              onChangeText={(label) => setDraft((d) => ({ ...d, label }))}
              maxLength={200}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
              testID="label-input"
            />
            <Text style={[styles.label, { color: theme.text }]}>{t('field.update.note')}</Text>
            <TextInput
              value={draft.note}
              onChangeText={(note) => setDraft((d) => ({ ...d, note }))}
              maxLength={2000}
              multiline
              style={[styles.input, styles.note, { color: theme.text, borderColor: theme.border }]}
              testID="note-input"
            />
            <Text style={{ color: theme.text }} testID="gps-status">
              {locating
                ? t('field.update.gpsLocating')
                : draft.gps && feature === null
                  ? draft.gps.accuracyM === null
                    ? ''
                    : t('field.update.gpsAccuracy', {
                        accuracy: ltr(Math.round(draft.gps.accuracyM)),
                      })
                  : draft.gps && warnings.gpsDistanceM !== null
                    ? `${t('field.update.gpsDistance', { distance: ltr(warnings.gpsDistanceM.toFixed(1)) })} · ${
                        draft.gps.accuracyM === null
                          ? ''
                          : t('field.update.gpsAccuracy', {
                              accuracy: ltr(Math.round(draft.gps.accuracyM)),
                            })
                      }`
                    : t('field.update.gpsUnavailable')}
            </Text>
            <Button
              variant="secondary"
              label={t('field.update.gpsRetry')}
              onPress={locate}
              busy={locating}
            />
          </>
        ) : null}
        {draft.step === 'photos' ? (
          <>
            {bundle.settings.photoRequirements.status === 'unavailable' ? (
              <Notice text={t('field.update.phase2Photos')} />
            ) : null}
            {requirements.map((requirement) => {
              const missing = missingPhotos(draft, [requirement])[0];
              return (
                <View key={requirement.key} style={styles.photoRow}>
                  <Text style={{ color: theme.text, flex: 1 }}>
                    {missing
                      ? t('field.update.photoRequired', {
                          count: ltr(missing.minCount),
                          key: requirement.key,
                        })
                      : `✓ ${t('field.update.photosComplete')}`}
                  </Text>
                  <Button
                    variant="secondary"
                    label={t('field.update.takePhoto')}
                    onPress={() => void takePhoto(requirement.key)}
                    busy={busy}
                    testID={`take-photo-${requirement.key}`}
                  />
                </View>
              );
            })}
            <Text style={{ color: theme.text }}>
              {t('field.update.summaryPhotos', { count: ltr(draft.photos.length) })}
            </Text>
          </>
        ) : null}
        {draft.step === 'review' ? (
          <>
            <Text style={{ color: theme.text }} testID="review-summary">
              {t(`items.workTypes.${draft.workType ?? 'civil'}`)} ·{' '}
              {t('field.update.summaryLines', {
                count: ltr(draft.work.length + Object.keys(draft.materials).length),
              })}{' '}
              · {t('field.update.summaryPhotos', { count: ltr(draft.photos.length) })}
            </Text>
            <Text style={{ color: theme.text }} testID="review-work-date">
              {t('field.update.workDate.label')}: {ltr(workDate)}
            </Text>
            {warnings.warnings.map((warning) => (
              <View
                key={warning}
                style={[styles.warning, { borderColor: statusTokens.inProgress.color }]}
              >
                <Text style={{ color: theme.text }} testID={`warning-${warning}`}>
                  ⚠{' '}
                  {t(`field.warnings.${warning}`, {
                    distance: ltr(bundle.settings.gpsWarningDistanceM),
                  })}
                </Text>
              </View>
            ))}
            {warnings.warnings.some((w) => !draft.acknowledged.includes(w)) ? (
              <Button
                variant="secondary"
                label={t('field.update.acknowledge')}
                onPress={() => setDraft((d) => acknowledge(d, warnings.warnings))}
                testID="acknowledge"
              />
            ) : null}
          </>
        ) : null}
        {problems.map((problem) => (
          <Text key={problem} style={{ color: theme.danger }} testID={`problem-${problem}`}>
            {t(`field.problems.${problem}`)}
          </Text>
        ))}
        {draft.step === 'work'
          ? overruns.map((overrun) => (
              <Text
                key={overrun.contractor.contractorLineId}
                style={{ color: theme.danger }}
                testID={`contractor-exceeded-${overrun.contractor.contractorLineId}`}
              >
                {t('field.update.performerExceeded', {
                  name: overrun.contractor.contractorName,
                  left: ltr(overrun.left),
                  unit: items.find((item) => item.id === overrun.itemId)?.unit ?? '',
                })}
              </Text>
            ))
          : null}
      </ScrollView>

      <View style={[styles.footer, { borderColor: theme.border }]}>
        <Button
          variant="secondary"
          label={stepIndex === 0 ? t('field.update.cancel') : t('field.update.back')}
          onPress={() => (stepIndex === 0 ? onCancel() : setDraft(goBack))}
          testID="wizard-back"
        />
        {draft.step === 'review' ? (
          <Button
            label={t('field.update.save')}
            onPress={() => void save()}
            busy={busy}
            disabled={!canSave(draft, requirements, warnings.warnings, contractorContext)}
            testID="wizard-save"
          />
        ) : (
          <Button
            label={t('field.update.next')}
            onPress={() => setDraft((d) => goNext(d, requirements, contractorContext))}
            disabled={problems.length > 0 || busy || (draft.step === 'work' && dateInvalid)}
            testID="wizard-next"
          />
        )}
      </View>
    </View>
  );
}

function ItemCard({
  item,
  overrun,
  draftTotal,
  children,
}: {
  item: CatalogItem;
  overrun: boolean;
  /** What the supervisor typed on this line in this update ('0' when nothing). */
  draftTotal: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <View
      style={[styles.item, { borderColor: overrun ? statusTokens.inProgress.color : theme.border }]}
    >
      <Text style={[styles.itemTitle, { color: theme.text }]}>
        {ltr(item.code)} — {item.description}
      </Text>
      <Text style={{ color: theme.text }}>
        {t('field.update.recorded', {
          recorded: ltr(item.recordedQuantity),
          quantity: ltr(item.quantity),
          unit: item.unit,
        })}
        {overrun ? ' ⚠' : ''}
      </Text>
      {isZeroQuantity(draftTotal) ? null : (
        <Text style={[styles.itemTitle, { color: theme.text }]} testID={`entered-${item.code}`}>
          {t('field.update.groups.entered', { quantity: ltr(draftTotal), unit: item.unit })}
        </Text>
      )}
      {children}
    </View>
  );
}

/**
 * A work item with one stepper per performer: each contractor of the work-order line (name, scope,
 * quantity left) and «الشركة نفسها», always offered. A line is split by raising several steppers.
 */
function WorkItemCard({
  item,
  draft,
  workDate,
  unsyncedByContractorLine,
  overrun,
  draftTotal,
  onStep,
  onDimensions,
}: {
  item: CatalogItem;
  draft: UpdateDraft;
  workDate: string;
  unsyncedByContractorLine: Readonly<Record<string, string>>;
  overrun: boolean;
  draftTotal: string;
  onStep: (performer: LinePerformer, delta: number) => void;
  onDimensions: (performer: LinePerformer, dimensions: LineDimensions | null) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const performers: { performer: LinePerformer; title: string; detail: string | null }[] = [
    // ADR-057: a contractor is offered from his registration day on.
    ...item.contractors
      .filter((contractor) => registeredBy(contractor, workDate))
      .map((contractor) => ({
        performer: { kind: 'contractor', contractorLineId: contractor.contractorLineId } as const,
        title: contractor.contractorName,
        detail: `${
          contractor.scope === null
            ? t('field.update.performerWholeLine')
            : t('field.update.performerScope', { scope: contractor.scope })
        } · ${t('field.update.performerLeft', {
          left: ltr(contractorLeft(contractor, unsyncedByContractorLine)),
          unit: item.unit,
        })}`,
      })),
    { performer: SELF_PERFORMER, title: t('field.update.performerSelf'), detail: null },
  ];
  return (
    <ItemCard item={item} overrun={overrun} draftTotal={draftTotal}>
      {performers.map(({ performer, title, detail }) => {
        const key = performerKeyOf(performer);
        return (
          <View
            key={key}
            style={[styles.performer, { borderColor: theme.border }]}
            testID={`work-${item.code}-${key}`}
          >
            <Text style={[styles.itemTitle, { color: theme.text }]}>{title}</Text>
            {detail ? <Text style={{ color: theme.text }}>{detail}</Text> : null}
            {item.needsDimensions ? (
              <DimensionsEditor
                initial={dimensionsOf(draft, item.id, performer)}
                quantity={workQuantity(draft, item.id, performer)}
                unit={item.unit}
                onChange={(dimensions) => onDimensions(performer, dimensions)}
                idPrefix={`work-${item.code}-${key}`}
              />
            ) : (
              <Stepper
                quantity={workQuantity(draft, item.id, performer)}
                onStep={(delta) => onStep(performer, delta)}
                idPrefix={`work-${item.code}-${key}`}
              />
            )}
          </View>
        );
      })}
    </ItemCard>
  );
}

const DIMENSION_FIELDS = [
  { field: 'lengthM', label: 'length' },
  { field: 'widthM', label: 'width' },
  { field: 'depthM', label: 'depth' },
] as const;

/**
 * Length, width and depth of a digging line in metres (ADR-056): a decimal keypad, up to 4
 * decimals, above zero. The quantity under them is the volume, shown and never typed.
 */
function DimensionsEditor({
  initial,
  quantity,
  unit,
  onChange,
  idPrefix,
}: {
  initial: LineDimensions | null;
  quantity: string;
  unit: string;
  onChange: (dimensions: LineDimensions | null) => void;
  idPrefix: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [texts, setTexts] = useState({
    lengthM: initial?.lengthM ?? '',
    widthM: initial?.widthM ?? '',
    depthM: initial?.depthM ?? '',
  });
  const invalid = (text: string) =>
    text.trim() !== '' && parseDimensions({ lengthM: text, widthM: '1', depthM: '1' }) === null;
  const edit = (field: (typeof DIMENSION_FIELDS)[number]['field'], text: string) => {
    const next = { ...texts, [field]: text };
    setTexts(next);
    onChange(parseDimensions(next));
  };
  return (
    <View style={styles.dimensions}>
      <Text style={{ color: theme.text, fontSize: typography.size.sm }}>
        {t('field.update.groups.dimensionsHint')}
      </Text>
      <View style={styles.dimensionRow}>
        {DIMENSION_FIELDS.map(({ field, label }) => (
          <View key={field} style={styles.dimensionCell}>
            <Text style={{ color: theme.text }}>{t(`field.update.groups.${label}`)}</Text>
            <TextInput
              value={texts[field]}
              onChangeText={(text) => edit(field, text)}
              keyboardType="decimal-pad"
              inputMode="decimal"
              maxLength={19}
              style={[
                styles.input,
                styles.dimensionInput,
                {
                  color: theme.text,
                  borderColor: invalid(texts[field]) ? theme.danger : theme.border,
                },
              ]}
              testID={`${idPrefix}-${label}`}
            />
          </View>
        ))}
      </View>
      {DIMENSION_FIELDS.some(({ field }) => invalid(texts[field])) ? (
        <Text style={{ color: theme.danger }} testID={`${idPrefix}-dimensions-invalid`}>
          {t('field.update.groups.dimensionsInvalid')}
        </Text>
      ) : null}
      <Text style={[styles.quantity, { color: theme.text }]} testID={`${idPrefix}-qty`}>
        {ltr(quantity)}
      </Text>
      <Text style={{ color: theme.text, fontSize: typography.size.sm }}>
        {t('field.update.groups.volume', { unit })}
      </Text>
    </View>
  );
}

/** element › main group › sub group › line (ADR-056) with a way back and a breadcrumb. */
function GroupedItems({
  element,
  groups,
  draft,
  renderItem,
}: {
  element: ElementKey;
  groups: readonly GroupedLines<CatalogItem>[];
  draft: UpdateDraft;
  renderItem: (item: CatalogItem) => ReactNode;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [path, setPath] = useState<GroupPath>(ROOT_PATH);
  if (groups.length === 0) {
    return (
      <Text style={{ color: theme.text }} testID="groups-empty">
        {t('field.update.groups.noGroups')}
      </Text>
    );
  }
  const view = groupView(groups, path);
  const crumbs = [
    t(`field.update.groups.elements.${element}`),
    ...(view.level === 'main' ? [] : [view.main]),
    ...(view.level === 'lines' ? [view.sub] : []),
  ];
  const entered = (lines: readonly CatalogItem[]) =>
    lines.filter((line) => !isZeroQuantity(enteredQuantity(draft, line.id))).length;
  const groupButton = (kind: 'main' | 'sub', name: string, lines: readonly CatalogItem[]) => (
    <Pressable
      key={`${kind}-${name}`}
      accessibilityRole="button"
      onPress={() =>
        setPath((current) => (kind === 'main' ? openMain(name) : openSub(current, name)))
      }
      style={[styles.choice, { borderColor: theme.border }]}
      testID={`group-${kind}-${name}`}
    >
      <Text style={{ color: theme.text, fontSize: typography.size.lg }}>{name}</Text>
      <Text style={{ color: theme.text }}>
        {t('field.update.groups.lineCount', { count: ltr(lines.length) })}
        {entered(lines) > 0
          ? ` · ${t('field.update.groups.enteredLines', { count: ltr(entered(lines)) })}`
          : ''}
      </Text>
    </Pressable>
  );
  return (
    <>
      <View style={styles.breadcrumb}>
        {path.main !== null ? (
          <Button
            variant="secondary"
            label={t('field.update.groups.up')}
            onPress={() => setPath(groupBack)}
            testID="group-back"
          />
        ) : null}
        <Text style={{ color: theme.text, flex: 1 }} testID="group-breadcrumb">
          {crumbs.join(' › ')}
        </Text>
      </View>
      {view.level === 'main' ? view.mains.map((m) => groupButton('main', m.name, m.lines)) : null}
      {view.level === 'sub' ? (
        <>
          {view.subs.map((s) => groupButton('sub', s.name, s.lines))}
          {view.direct.map(renderItem)}
        </>
      ) : null}
      {view.level === 'lines' ? view.lines.map(renderItem) : null}
    </>
  );
}

function Stepper({
  quantity,
  onStep,
  idPrefix,
}: {
  quantity: string;
  onStep: (delta: number) => void;
  idPrefix: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stepper}>
      {[-10, -1].map((delta) => (
        <StepButton
          key={delta}
          delta={delta}
          onPress={() => onStep(delta)}
          testID={`${idPrefix}-${delta}`}
        />
      ))}
      <Text style={[styles.quantity, { color: theme.text }]} testID={`${idPrefix}-qty`}>
        {ltr(quantity)}
      </Text>
      {[1, 10].map((delta) => (
        <StepButton
          key={delta}
          delta={delta}
          onPress={() => onStep(delta)}
          testID={`${idPrefix}-+${delta}`}
        />
      ))}
    </View>
  );
}

function StepButton({
  delta,
  onPress,
  testID,
}: {
  delta: number;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={delta > 0 ? `+${delta}` : String(delta)}
      onPress={onPress}
      style={[styles.stepButton, { borderColor: theme.text }]}
      testID={testID}
    >
      <Text style={{ color: theme.text, fontWeight: '700' }}>
        {ltr(delta > 0 ? `+${delta}` : String(delta))}
      </Text>
    </Pressable>
  );
}

function Choice({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, { borderColor: selected ? theme.brand : theme.border }]}
      testID={testID}
    >
      <Text style={{ color: theme.text, fontSize: typography.size.lg }}>
        {selected ? '◉' : '○'} {label}
      </Text>
    </Pressable>
  );
}

function Notice({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text style={[styles.notice, { color: theme.text, borderColor: theme.border }]}>{text}</Text>
  );
}

/**
 * ADR-057: «تاريخ الشغل» — today or any earlier day, typed (YYYY-MM-DD) or stepped a day at a time.
 * No later day: the next-day button stops at today.
 */
function WorkDateBar({
  workDate,
  today,
  onPick,
  onInvalid,
}: {
  workDate: string;
  today: string;
  onPick: (day: string) => void;
  onInvalid: (invalid: boolean) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [text, setText] = useState(workDate);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(workDate);
    setInvalid(false);
    onInvalid(false);
  }, [workDate]);
  const typed = (value: string) => {
    setText(value);
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && shiftDay(value, 0) === value;
    const bad = !valid || value > today;
    setInvalid(bad);
    onInvalid(bad);
    if (!bad && value !== workDate) onPick(value);
  };
  return (
    <View style={[styles.item, { borderColor: theme.border }]} testID="work-date">
      <Text style={[styles.label, { color: theme.text }]}>{t('field.update.workDate.label')}</Text>
      <View style={styles.stepperRow}>
        <Button
          variant="secondary"
          label={t('field.update.workDate.previous')}
          onPress={() => onPick(shiftDay(workDate, -1))}
          testID="work-date-previous"
        />
        <TextInput
          value={text}
          onChangeText={typed}
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
          style={[styles.input, styles.dateInput, { color: theme.text, borderColor: theme.border }]}
          testID="work-date-input"
        />
        <Button
          variant="secondary"
          label={t('field.update.workDate.next')}
          onPress={() => onPick(shiftDay(workDate, 1))}
          disabled={workDate >= today}
          testID="work-date-next"
        />
      </View>
      {workDate !== today ? (
        <Button
          variant="secondary"
          label={t('field.update.workDate.today')}
          onPress={() => onPick(today)}
          testID="work-date-today"
        />
      ) : null}
      {invalid ? (
        <Text style={{ color: theme.text }} testID="work-date-invalid">
          {t('field.update.workDate.invalid')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { padding: spacing.lg, gap: spacing.xs },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  progressTrack: { height: 8, borderWidth: 1, borderRadius: radius.sm, overflow: 'hidden' },
  progressFill: { height: '100%' },
  body: { padding: spacing.lg, gap: spacing.md },
  label: { fontWeight: '600' },
  input: {
    borderWidth: 2,
    borderRadius: radius.md,
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.md,
  },
  note: { minHeight: 88, textAlignVertical: 'top' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  warning: { borderWidth: 2, borderRadius: radius.md, padding: spacing.md },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: 1,
  },
  item: { borderWidth: 2, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  itemTitle: { fontWeight: '600' },
  performer: {
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dimensions: { gap: spacing.xs },
  dimensionRow: { flexDirection: 'row', gap: spacing.sm },
  dimensionCell: { flex: 1, gap: spacing.xs },
  dimensionInput: { textAlign: 'center', writingDirection: 'ltr' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dateInput: { flex: 1, textAlign: 'center', writingDirection: 'ltr' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, writingDirection: 'ltr' },
  stepButton: {
    minWidth: minTouchTarget,
    minHeight: minTouchTarget,
    borderWidth: 2,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantity: { minWidth: 72, textAlign: 'center', fontSize: typography.size.lg, fontWeight: '700' },
  choice: {
    borderWidth: 2,
    borderRadius: radius.md,
    padding: spacing.lg,
    minHeight: minTouchTarget,
  },
  notice: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: typography.size.sm,
  },
});
