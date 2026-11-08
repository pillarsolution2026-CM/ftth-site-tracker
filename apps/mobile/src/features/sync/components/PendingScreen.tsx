import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import type { ExecutionUpdate } from '@ftth/shared';
import { radius, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { useTheme } from '../../../shared/ui/theme';
import { useField } from '../hooks/FieldProvider';
import { OwnEditsList } from '../../asbuilt/components/OwnEditsList';
import { rejectionKey } from '../../asbuilt/model/own-edits';
import { pendingRows, reviewFor } from '../model/pending-rows';
import { SyncStatusBar } from './SyncStatusBar';

const STATE_TOKEN = {
  pending: statusTokens.inProgress,
  applied: statusTokens.executed,
  rejected: statusTokens.rejected,
} as const;

/** «في الانتظار»: every update saved on this device, its sync state and the server's review. */
export function PendingScreen({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const theme = useTheme();
  const { entries: allEntries, store, bundle } = useField();
  // Execution updates here; As-Built edits are listed with their status below.
  const rows = useMemo(() => pendingRows(allEntries), [allEntries]);
  const [remote, setRemote] = useState<Map<string, ExecutionUpdate>>(new Map());

  useEffect(() => {
    let active = true;
    void (async () => {
      const byOp = new Map<string, ExecutionUpdate>();
      const updateRows = rows.flatMap((row) => (row.type === 'update' ? [row] : []));
      for (const featureId of new Set(updateRows.map((row) => row.op.payload.featureId))) {
        for (const update of await store.remoteUpdatesFor(featureId))
          byOp.set(update.clientOpId, update);
      }
      if (active) setRemote(byOp);
    })();
    return () => {
      active = false;
    };
  }, [rows, store]);

  const codeOf = (featureId: string) =>
    bundle?.features.find((f) => f.id === featureId)?.code ?? '';

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <SyncStatusBar onOpenPending={() => undefined} />
      <Text style={[styles.title, { color: theme.text }]}>{t('field.pending.title')}</Text>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.entry.clientOpId}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={{ color: theme.text }}>{t('field.pending.empty')}</Text>}
        ListFooterComponent={<OwnEditsList />}
        renderItem={({ item: row }) => {
          const entry = row.entry;
          const token = STATE_TOKEN[entry.state];
          const review = reviewFor(row, remote);
          const kindLabel =
            row.type === 'update'
              ? t(`items.workTypes.${row.op.payload.workType}`)
              : t('field.pending.kinds.placementPoint');
          return (
            <View
              style={[styles.row, { borderColor: token.color }]}
              testID={`entry-${entry.clientOpId}`}
            >
              <Text style={[styles.rowTitle, { color: theme.text }]}>
                {kindLabel} · {ltr(codeOf(row.op.payload.featureId))} ·{' '}
                {ltr(new Date(row.op.capturedAt).toLocaleString())}
              </Text>
              <Text style={{ color: theme.text }}>
                {t(`field.pending.states.${entry.state}`)}
                {entry.attempts > 0
                  ? ` · ${t('field.pending.attempts', { count: ltr(entry.attempts) })}`
                  : ''}
              </Text>
              {entry.rejection ? (
                <Text style={{ color: theme.danger }}>{t(rejectionKey(entry.rejection))}</Text>
              ) : null}
              {review ? (
                <Text style={{ color: theme.text }}>
                  {t(`field.pending.updateStatus.${review.status}`)}
                  {review.reviewReason
                    ? ` · ${t('field.pending.reviewReason', { reason: review.reviewReason })}`
                    : ''}
                </Text>
              ) : null}
            </View>
          );
        }}
      />
      <View style={styles.footer}>
        <Button variant="secondary" label={t('field.update.back')} onPress={onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: typography.size.xl, fontWeight: '700', padding: spacing.lg },
  list: { padding: spacing.lg, gap: spacing.md },
  row: { borderWidth: 2, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  rowTitle: { fontWeight: '600' },
  footer: { padding: spacing.lg },
});
