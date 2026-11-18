import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import type { OfflineDrawing } from '@ftth/shared';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { useTheme } from '../../../shared/ui/theme';
import { groupBySite } from '../model/drawing-picker';

interface DrawingPickerProps {
  drawings: readonly OfflineDrawing[];
  /** drawingId to the revision number held on the phone. */
  downloaded: Readonly<Record<string, number>>;
  currentDrawingId: string | null;
  busy: boolean;
  /** Background download progress; null when idle. */
  progress?: { done: number; total: number } | null;
  /** The picked drawing is not on the phone and could not be downloaded. */
  unavailable?: boolean;
  onSelect: (drawing: OfflineDrawing) => void;
}

/** Supervisor picks the site, then its drawing: General or Secondary n (ADR-049 part B). */
export function DrawingPicker({
  drawings,
  downloaded,
  currentDrawingId,
  busy,
  progress = null,
  unavailable = false,
  onSelect,
}: DrawingPickerProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const groups = groupBySite(drawings);
  const currentSite = drawings.find((d) => d.drawingId === currentDrawingId)?.siteId;
  const [siteKey, setSiteKey] = useState<string | null | undefined>(currentSite);
  const shown = groups.find((g) => g.siteId === siteKey) ?? groups[0];

  if (groups.length === 0) {
    return (
      <Text style={[styles.empty, { color: theme.text }]} testID="drawing-picker-empty">
        {t('mobileSites.empty')}
      </Text>
    );
  }
  return (
    <View style={[styles.panel, { backgroundColor: theme.background }]} testID="drawing-picker">
      {unavailable ? (
        <Text style={[styles.title, { color: theme.text }]} testID="drawing-unavailable">
          {t('mobileSites.notOnPhoneOffline')}
        </Text>
      ) : null}
      {progress ? (
        <Text style={{ color: theme.text, fontSize: typography.size.sm }} testID="auto-progress">
          {t('mobileSites.autoDownloading', {
            done: ltr(Math.min(progress.done + 1, progress.total)),
            total: ltr(progress.total),
          })}
        </Text>
      ) : null}
      <Text style={[styles.title, { color: theme.text }]}>{t('mobileSites.chooseSite')}</Text>
      <View style={styles.row}>
        {groups.map((group) => {
          const on = group === shown;
          return (
            <Pressable
              key={group.siteId ?? 'none'}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setSiteKey(group.siteId)}
              style={[styles.chip, { borderColor: theme.text }, on && styles.chipOn]}
              testID={`site-${group.siteId ?? 'none'}`}
            >
              <Text style={{ color: theme.text, fontWeight: on ? '700' : '400' }}>
                {group.siteId === null ? t('mobileSites.noSite') : (group.name ?? '')}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.title, { color: theme.text }]}>{t('mobileSites.chooseDrawing')}</Text>
      {shown?.drawings.map((drawing) => {
        const revNo = downloaded[drawing.drawingId];
        const current = drawing.drawingId === currentDrawingId;
        return (
          <Pressable
            key={drawing.drawingId}
            accessibilityRole="button"
            accessibilityState={{ selected: current, disabled: busy }}
            disabled={busy}
            onPress={() => onSelect(drawing)}
            style={[styles.drawing, { borderColor: theme.text }, current && styles.chipOn]}
            testID={`drawing-${drawing.drawingId}`}
          >
            <Text style={{ color: theme.text, fontWeight: current ? '700' : '400' }}>
              {drawing.kind === 'general'
                ? t('mobileSites.general')
                : t('mobileSites.secondary', { n: ltr(drawing.ordinal) })}
            </Text>
            <Text style={{ color: theme.text, fontSize: typography.size.sm }}>
              {revNo === undefined
                ? t('mobileSites.notOnPhone')
                : revNo === drawing.revision.revNo
                  ? t('mobileSites.onPhone', { revNo: ltr(revNo) })
                  : t('mobileSites.onPhoneOld', {
                      revNo: ltr(revNo),
                      latest: ltr(drawing.revision.revNo),
                    })}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: spacing.md, gap: spacing.sm },
  title: { fontSize: typography.size.sm, fontWeight: '600' },
  empty: { padding: spacing.lg, textAlign: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderWidth: 2,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  chipOn: { borderWidth: 4 },
  drawing: {
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderWidth: 2,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});
