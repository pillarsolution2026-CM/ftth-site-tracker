import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createProjectCrs } from '@ftth/geo';
import { ltr } from '@ftth/i18n';
import { GPS_PROPOSAL_MAX_ACCURACY_M, type GpsFix, type OfflineFeature } from '@ftth/shared';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import type { GpsWatch } from '../../../shared/device/location';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { useTheme } from '../../../shared/ui/theme';
import { distanceToFeature } from '../../cad/model/viewport';
import type { CaptureRequest } from '../../camera/hooks/usePhotoCapture';
import { useField } from '../../sync/hooks/FieldProvider';
import type { CapturedPhoto } from '../../update/model/update-wizard';
import {
  accuracyGate,
  buildProposeOp,
  canSendProposal,
  formatAccuracy,
} from '../model/gps-proposal';

export interface ProposePointDeps {
  capturePhoto(request: CaptureRequest): Promise<CapturedPhoto | null>;
  watch(onFix: (fix: GpsFix) => void): Promise<GpsWatch>;
  newId(): string;
  now(): Date;
  author: string;
}

interface ProposePointScreenProps {
  feature: OfflineFeature;
  deps: ProposePointDeps;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * «ابعت نقطتي» (ADR-037): the supervisor stands at the item and sends the phone's fix. The send
 * button is locked until the live accuracy is ±5 m or better; the fix that is sent is the
 * reading at the moment of the press.
 */
export function ProposePointScreen({ feature, deps, onDone, onCancel }: ProposePointScreenProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const { bundle, record } = useField();
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [denied, setDenied] = useState(false);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef<GpsFix | null>(null);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | null = null;
    void deps
      .watch((next) => {
        if (!active) return;
        latest.current = next;
        setFix(next);
      })
      .then((watch) => {
        if (!active) {
          if (watch.ok) watch.stop();
          return;
        }
        if (watch.ok) stop = watch.stop;
        else setDenied(true);
      })
      .catch(() => active && setDenied(true));
    return () => {
      active = false;
      stop?.();
    };
  }, [deps]);

  const distanceM = useMemo(() => {
    if (!fix || !bundle) return null;
    const projected = createProjectCrs(bundle.project.crsEpsg).fromWgs84({
      lon: fix.lon,
      lat: fix.lat,
    });
    return distanceToFeature(feature, projected);
  }, [bundle, feature, fix]);

  if (!bundle || !bundle.revision) return null;
  const revisionId = bundle.revision.id;
  const gate = accuracyGate(fix?.accuracyM);
  const sendable = gate === 'ok' && !busy;

  const takePhoto = async () => {
    setBusy(true);
    try {
      const shot = await deps.capturePhoto({
        requirementKey: 'general',
        gps: latest.current,
        watermark: { featureCode: feature.code, featureType: feature.type, author: deps.author },
      });
      if (shot) setPhoto(shot);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    // Freeze the reading now; later fixes do not change what is sent.
    const frozen = latest.current;
    if (!canSendProposal(frozen)) return;
    setBusy(true);
    try {
      const op = buildProposeOp({
        clientOpId: deps.newId(),
        capturedAt: deps.now().toISOString(),
        designRevisionId: revisionId,
        featureId: feature.id,
        fix: frozen,
        photo,
        note,
      });
      await record(
        op,
        photo
          ? [{ photoId: photo.photoId, fileUri: photo.fileUri, sizeBytes: photo.sizeBytes }]
          : [],
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const accuracyText =
    fix?.accuracyM !== null && fix?.accuracyM !== undefined
      ? t('field.placement.accuracy', { accuracy: ltr(formatAccuracy(fix.accuracyM)) })
      : denied
        ? t('field.placement.noPermission')
        : t('field.placement.noFix');
  const accuracyColor = gate === 'ok' ? theme.text : theme.danger;

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          {t('field.placement.title')} · {t(`featureType.${feature.type}`)}{' '}
          {feature.code ? ltr(feature.code) : ''}
        </Text>
        <Text style={{ color: theme.text }}>{t('field.placement.intro')}</Text>
        <View accessibilityLiveRegion="polite" style={styles.block} testID="accuracy-panel">
          <Text
            style={[styles.accuracy, { color: accuracyColor }]}
            testID="accuracy-text"
            accessibilityLabel={accuracyText}
          >
            {accuracyText}
          </Text>
          {distanceM !== null ? (
            <Text style={{ color: theme.text }} testID="distance-text">
              {t('field.placement.distance', { distance: ltr(Math.round(distanceM)) })}
            </Text>
          ) : null}
          {gate === 'too_low' ? (
            <Text style={{ color: theme.danger }} testID="accuracy-hint">
              {t('field.placement.wait', { max: ltr(GPS_PROPOSAL_MAX_ACCURACY_M) })}
            </Text>
          ) : null}
          {gate === 'ok' ? (
            <Text style={{ color: theme.text }}>{t('field.placement.ready')}</Text>
          ) : null}
        </View>

        <Text style={[styles.label, { color: theme.text }]}>
          {t('field.placement.photoOptional')}
        </Text>
        {photo ? (
          <Text style={{ color: theme.text }}>{t('field.placement.photoTaken')}</Text>
        ) : null}
        <Button
          variant="secondary"
          label={photo ? t('field.placement.retakePhoto') : t('field.placement.takePhoto')}
          onPress={() => void takePhoto()}
          disabled={busy}
          testID="take-photo"
        />
        {photo ? (
          <Button
            variant="secondary"
            label={t('field.placement.removePhoto')}
            onPress={() => setPhoto(null)}
            testID="remove-photo"
          />
        ) : null}

        <Text style={[styles.label, { color: theme.text }]}>{t('field.placement.note')}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          maxLength={500}
          multiline
          accessibilityLabel={t('field.placement.note')}
          style={[styles.input, { color: theme.text, borderColor: theme.text }]}
          testID="note-input"
        />
      </ScrollView>
      <View style={styles.footer}>
        <Button
          label={t('field.placement.send')}
          onPress={() => void send()}
          disabled={!sendable}
          busy={busy}
          testID="send-point"
        />
        <Button variant="secondary" label={t('field.placement.cancel')} onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: spacing.lg, gap: spacing.md },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  block: { gap: spacing.xs },
  accuracy: { fontSize: typography.size.lg, fontWeight: '700' },
  label: { fontWeight: '600' },
  input: {
    minHeight: minTouchTarget * 2,
    borderWidth: 2,
    borderRadius: radius.md,
    padding: spacing.md,
    textAlignVertical: 'top',
  },
  footer: { padding: spacing.lg, gap: spacing.sm },
});
