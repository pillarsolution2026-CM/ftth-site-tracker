import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { ltr } from '@ftth/i18n';
import { FEATURE_TYPES, type FeatureType } from '@ftth/shared';
import {
  cadPalette,
  minTouchTarget,
  radius,
  spacing,
  typography,
  type CadMode,
} from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { useTheme } from '../../../shared/ui/theme';
import { SyncStatusBar } from '../../sync/components/SyncStatusBar';
import { useField } from '../../sync/hooks/FieldProvider';
import { useViewportGestures } from '../hooks/useViewportGestures';
import {
  boundsOf,
  fitBounds,
  formatEastingNorthing,
  pickAtCrosshair,
  type Viewport,
} from '../model/viewport';
import { CadCanvas } from './CadCanvas';

interface CadScreenProps {
  onUpdate: (featureId: string) => void;
  onOpenPending: () => void;
}

/** Main screen of the supervisor app (plan): the drawing, crosshair, E/N, layers, day/night. */
export function CadScreen({ onUpdate, onOpenPending }: CadScreenProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const { bundle, bundleStatus, download, entries } = useField();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [mode, setMode] = useState<CadMode>(theme.dark ? 'night' : 'day');
  const [visible, setVisible] = useState<ReadonlySet<FeatureType>>(new Set(FEATURE_TYPES));
  const [layersOpen, setLayersOpen] = useState(false);
  const features = useMemo(() => bundle?.features ?? [], [bundle]);

  const fit = () => {
    const bounds = boundsOf(features);
    if (bounds && size) setViewport(fitBounds(bounds, size.width, size.height));
  };
  // Re-fit when the drawing or the screen size changes.
  useEffect(fit, [features, size]);

  const gestures = useViewportGestures(viewport, setViewport, origin);
  const picked = viewport ? pickAtCrosshair(features, viewport, visible) : null;
  const updatedIds = useMemo(
    () => new Set(entries.filter((e) => e.state !== 'rejected').map((e) => e.op.payload.featureId)),
    [entries],
  );
  const updatesOnPicked = picked
    ? entries.filter((e) => e.op.payload.featureId === picked.id).length
    : 0;

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height, x, y } = event.nativeEvent.layout;
    setSize({ width, height });
    setOrigin({ x, y });
  };

  if (!bundle) {
    return (
      <View style={[styles.empty, { backgroundColor: theme.background }]}>
        <SyncStatusBar onOpenPending={onOpenPending} />
        <View style={styles.emptyBody}>
          <Text style={{ color: theme.text, fontSize: typography.size.lg }}>
            {bundleStatus === 'error' ? t('field.downloadFailed') : t('field.title')}
          </Text>
          <Button
            label={bundleStatus === 'downloading' ? t('field.downloading') : t('field.download')}
            busy={bundleStatus === 'downloading' || bundleStatus === 'loading'}
            onPress={() => void download()}
            testID="download-bundle"
          />
        </View>
      </View>
    );
  }

  const coords = viewport ? formatEastingNorthing(viewport) : null;
  const palette = cadPalette[mode];
  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      <SyncStatusBar onOpenPending={onOpenPending} />
      <View style={[styles.toolbar, { backgroundColor: theme.background }]}>
        <Text style={[styles.revision, { color: theme.text }]}>
          {bundle.revision
            ? t('field.revision', { revNo: ltr(bundle.revision.revNo) })
            : t('field.noRevision')}
        </Text>
        <ToolButton
          label={t('field.cad.layers')}
          onPress={() => setLayersOpen((open) => !open)}
          testID="layers-toggle"
        />
        <ToolButton
          label={mode === 'night' ? t('field.cad.day') : t('field.cad.night')}
          onPress={() => setMode((m) => (m === 'night' ? 'day' : 'night'))}
          testID="mode-toggle"
        />
        <ToolButton label={t('field.cad.fit')} onPress={fit} testID="fit" />
      </View>
      {layersOpen ? (
        <View style={[styles.layers, { backgroundColor: theme.background }]} testID="layers-panel">
          {FEATURE_TYPES.map((type) => {
            const on = visible.has(type);
            return (
              <Pressable
                key={type}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                onPress={() =>
                  setVisible((current) => {
                    const next = new Set(current);
                    if (on) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                style={styles.layerRow}
                testID={`layer-${type}`}
              >
                <Text style={{ color: palette[type], fontSize: typography.size.lg }}>
                  {on ? '■' : '□'}
                </Text>
                <Text style={{ color: theme.text }}>{t(`featureType.${type}`)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {features.length === 0 ? (
        <Text style={[styles.hint, { color: palette.text }]}>
          {bundle.revision ? t('field.noFeatures') : t('field.noRevision')}
        </Text>
      ) : null}
      <View style={styles.canvas} onLayout={onLayout} testID="cad-area" {...gestures.panHandlers}>
        {viewport ? (
          <CadCanvas
            features={features}
            viewport={viewport}
            visible={visible}
            mode={mode}
            selectedId={picked?.id ?? null}
            updatedIds={updatedIds}
          />
        ) : null}
      </View>
      <View style={[styles.bottom, { backgroundColor: theme.background }]}>
        {coords ? (
          <Text style={[styles.coords, { color: theme.text }]} testID="coordinates">
            {ltr(t('field.cad.coordinates', { e: coords.e, n: coords.n }))}
          </Text>
        ) : null}
        {picked ? (
          <View style={styles.card} testID="feature-card">
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {t(`featureType.${picked.type}`)} {picked.code ? ltr(picked.code) : ''}
            </Text>
            {picked.lengthM ? (
              <Text style={{ color: theme.text }}>
                {t('field.cad.designLength', { length: ltr(picked.lengthM) })}
              </Text>
            ) : null}
            {updatesOnPicked > 0 ? (
              <Text style={{ color: theme.text }}>
                {t('field.cad.updatesOnFeature', { count: ltr(updatesOnPicked) })}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={{ color: theme.text }}>{t('field.cad.nothingUnderCrosshair')}</Text>
        )}
        <Button
          label={t('field.cad.update')}
          onPress={() => picked && onUpdate(picked.id)}
          disabled={!picked}
          testID="update-button"
        />
      </View>
    </View>
  );
}

function ToolButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={[styles.tool, { borderColor: theme.text }]}
    >
      <Text style={{ color: theme.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  empty: { flex: 1 },
  emptyBody: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm },
  revision: { flex: 1, fontSize: typography.size.sm },
  tool: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderWidth: 2,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  layers: { padding: spacing.md, gap: spacing.xs },
  layerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: minTouchTarget,
  },
  hint: { padding: spacing.lg, textAlign: 'center' },
  canvas: { flex: 1, overflow: 'hidden' },
  bottom: { padding: spacing.md, gap: spacing.sm },
  coords: { fontFamily: 'monospace', fontSize: typography.size.sm, writingDirection: 'ltr' },
  card: { gap: spacing.xs },
  cardTitle: { fontSize: typography.size.lg, fontWeight: '700' },
});
