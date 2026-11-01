import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import {
  WORK_TYPES,
  type CatalogItem,
  type GpsFix,
  type OfflineFeature,
  type UpdateLineRole,
} from '@ftth/shared';
import { minTouchTarget, radius, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import { addQuantities } from '../../../shared/model/quantity';
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
  goBack,
  goNext,
  itemsForActivity,
  missingPhotos,
  photoRequirementsFor,
  startDraft,
  stepLine,
  stepProblems,
  UPDATE_STEPS,
  type CapturedPhoto,
  type UpdateDraft,
} from '../model/update-wizard';

export interface UpdateWizardDeps {
  capturePhoto(request: CaptureRequest): Promise<CapturedPhoto | null>;
  locate(): Promise<GpsFix | null>;
  newId(): string;
  now(): Date;
  author: string;
}

interface UpdateWizardScreenProps {
  feature: OfflineFeature;
  deps: UpdateWizardDeps;
  onDone: () => void;
  onCancel: () => void;
}

/** The «تحديث» tool in 6 fixed steps with a progress bar and a way back on every step (plan). */
export function UpdateWizardScreen({ feature, deps, onDone, onCancel }: UpdateWizardScreenProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const { bundle, entries, record } = useField();
  const [draft, setDraft] = useState<UpdateDraft>(() => startDraft(feature));
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);

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
  const unsyncedByItem = useMemo(() => {
    // Lines the server did not count yet when the bundle was built.
    const totals: Record<string, string> = {};
    const since = bundle?.serverTime ?? '';
    for (const entry of entries) {
      if (entry.op.kind !== 'execution_update.record') continue;
      if (entry.state === 'rejected' || entry.op.capturedAt < since) continue;
      for (const line of entry.op.payload.lines) {
        totals[line.workOrderItemId] = addQuantities(
          totals[line.workOrderItemId] ?? '0',
          line.quantity,
        );
      }
    }
    return totals;
  }, [bundle, entries]);

  if (!bundle || !bundle.revision) return null;
  const warnings = computeWarnings(draft, {
    crsEpsg: bundle.project.crsEpsg,
    gpsWarningDistanceM: bundle.settings.gpsWarningDistanceM,
    catalog: bundle.catalog,
    unsyncedByItem,
  });
  const stepIndex = UPDATE_STEPS.indexOf(draft.step);
  const problems = stepProblems(draft, draft.step, requirements);
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
        watermark: { featureCode: feature.code, featureType: feature.type, author: deps.author },
      });
      if (photo) setDraft((d) => ({ ...d, photos: [...d.photos, photo] }));
    } finally {
      setBusy(false);
    }
  };

  const lineList = (role: UpdateLineRole) =>
    items.length === 0 ? (
      <Text style={{ color: theme.text }}>{t('field.update.noItems')}</Text>
    ) : (
      items.map((item) => (
        <ItemStepper
          key={`${role}-${item.id}`}
          item={item}
          quantity={(role === 'work' ? draft.work : draft.materials)[item.id] ?? '0'}
          overrun={warnings.overrunItemIds.includes(item.id)}
          onStep={(delta) => setDraft((d) => stepLine(d, role, item.id, delta))}
          role={role}
        />
      ))
    );

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>
          {t(`featureType.${feature.type}`)} {feature.code ? ltr(feature.code) : ''}
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
            <Notice text={t('field.update.phase2Items')} />
            <Notice text={t('field.update.suggestedUnavailable')} />
            {lineList(draft.step === 'work' ? 'work' : 'material')}
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
                count: ltr(Object.keys(draft.work).length + Object.keys(draft.materials).length),
              })}{' '}
              · {t('field.update.summaryPhotos', { count: ltr(draft.photos.length) })}
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
            disabled={!canSave(draft, requirements, warnings.warnings)}
            testID="wizard-save"
          />
        ) : (
          <Button
            label={t('field.update.next')}
            onPress={() => setDraft((d) => goNext(d, requirements))}
            disabled={problems.length > 0 || busy}
            testID="wizard-next"
          />
        )}
      </View>
    </View>
  );
}

function ItemStepper({
  item,
  quantity,
  overrun,
  onStep,
  role,
}: {
  item: CatalogItem;
  quantity: string;
  overrun: boolean;
  onStep: (delta: number) => void;
  role: UpdateLineRole;
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
      <View style={styles.stepper}>
        {[-10, -1].map((delta) => (
          <StepButton
            key={delta}
            delta={delta}
            onPress={() => onStep(delta)}
            testID={`${role}-${item.code}-${delta}`}
          />
        ))}
        <Text style={[styles.quantity, { color: theme.text }]} testID={`${role}-${item.code}-qty`}>
          {ltr(quantity)}
        </Text>
        {[1, 10].map((delta) => (
          <StepButton
            key={delta}
            delta={delta}
            onPress={() => onStep(delta)}
            testID={`${role}-${item.code}-+${delta}`}
          />
        ))}
      </View>
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
