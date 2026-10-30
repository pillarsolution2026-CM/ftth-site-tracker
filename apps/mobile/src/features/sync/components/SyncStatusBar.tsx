import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import { minTouchTarget, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { useTheme } from '../../../shared/ui/theme';
import { useField } from '../hooks/FieldProvider';

/** Always-visible offline state (plan): unsynced count, waiting photos, last sync, and why. */
export function SyncStatusBar({ onOpenPending }: { onOpenPending: () => void }) {
  const { t } = useI18n();
  const theme = useTheme();
  const { summary, lastSyncAt, syncState, syncNow } = useField();

  const lines: string[] = [];
  if (summary.pending > 0) lines.push(t('field.sync.pending', { count: ltr(summary.pending) }));
  if (summary.photosWaiting > 0) {
    lines.push(t('field.sync.photosWaiting', { count: ltr(summary.photosWaiting) }));
  }
  if (summary.rejected > 0) lines.push(t('field.sync.rejected', { count: ltr(summary.rejected) }));
  if (lines.length === 0) lines.push(t('field.sync.allSynced'));

  const stateText =
    syncState === 'syncing'
      ? t('field.sync.syncing')
      : syncState === 'offline'
        ? t('field.sync.offline')
        : syncState === 'unauthorized'
          ? t('field.sync.unauthorized')
          : syncState === 'forbidden'
            ? t('field.sync.forbidden')
            : syncState === 'server_error'
              ? t('field.sync.serverError')
              : lastSyncAt
                ? t('field.sync.lastSync', { time: ltr(new Date(lastSyncAt).toLocaleTimeString()) })
                : t('field.sync.never');
  const attention =
    summary.rejected > 0 || syncState === 'forbidden' || syncState === 'unauthorized';
  const status = attention
    ? statusTokens.rejected
    : summary.pending > 0
      ? statusTokens.inProgress
      : statusTokens.approved;

  return (
    <View style={[styles.bar, { borderColor: status.color, backgroundColor: theme.background }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('field.pending.title')}
        onPress={onOpenPending}
        style={styles.info}
        testID="sync-status"
      >
        {/* Icon-like marker + text: status is never colour alone. */}
        <Text style={[styles.marker, { color: status.color }]}>
          {attention ? '!' : summary.pending > 0 ? '↑' : '✓'}
        </Text>
        <View style={styles.texts}>
          <Text style={[styles.main, { color: theme.text }]}>{lines.join(' · ')}</Text>
          <Text style={[styles.sub, { color: theme.text }]}>{stateText}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('field.sync.syncNow')}
        onPress={syncNow}
        disabled={syncState === 'syncing'}
        style={[styles.syncButton, { borderColor: theme.text }]}
        testID="sync-now"
      >
        <Text style={{ color: theme.text, fontWeight: '600' }}>{t('field.sync.syncNow')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  info: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: minTouchTarget,
  },
  marker: { fontSize: typography.size.xl, fontWeight: '800', width: 24, textAlign: 'center' },
  texts: { flex: 1 },
  main: { fontSize: typography.size.md, fontWeight: '600' },
  sub: { fontSize: typography.size.sm },
  syncButton: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderWidth: 2,
    borderRadius: 8,
    justifyContent: 'center',
  },
});
