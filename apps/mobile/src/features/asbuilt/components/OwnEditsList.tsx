import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ltr } from '@ftth/i18n';
import { radius, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { useTheme } from '../../../shared/ui/theme';
import { useField } from '../../sync/hooks/FieldProvider';
import { buildAsBuiltState } from '../model/asbuilt-state';
import { ownEditRows, rejectionKey } from '../model/own-edits';

const TOKEN = {
  queued: statusTokens.inProgress,
  pending: statusTokens.inProgress,
  approved: statusTokens.approved,
  rejected: statusTokens.rejected,
} as const;

/** The user's own As-Built edits with status (pending / approved / rejected + reason). */
export function OwnEditsList() {
  const { t } = useI18n();
  const theme = useTheme();
  const { bundle, entries, asBuiltEdits, userId } = useField();
  const rows = useMemo(() => {
    if (!bundle) return [];
    const state = buildAsBuiltState({ bundle, remoteEdits: asBuiltEdits, entries, userId });
    return ownEditRows(state);
  }, [asBuiltEdits, bundle, entries, userId]);
  const codeOf = (featureId: string) =>
    bundle?.features.find((f) => f.id === featureId)?.code ?? '';

  return (
    <View style={styles.root} testID="own-asbuilt-edits">
      <Text style={[styles.title, { color: theme.text }]}>{t('asbuilt.own.title')}</Text>
      {rows.length === 0 ? (
        <Text style={{ color: theme.text }}>{t('asbuilt.own.empty')}</Text>
      ) : null}
      {rows.map((row) => {
        const token = TOKEN[row.status];
        return (
          <View
            key={row.clientOpId}
            style={[styles.row, { borderColor: token.color }]}
            testID={`asbuilt-entry-${row.clientOpId}`}
          >
            <Text style={[styles.rowTitle, { color: theme.text }]}>
              {t(`asbuilt.own.kinds.${row.kind}`)}
              {codeOf(row.featureId) ? ` · ${ltr(codeOf(row.featureId))}` : ''} {'·'}{' '}
              {ltr(new Date(row.capturedAt).toLocaleString())}
            </Text>
            <Text style={{ color: theme.text }}>
              {token.icon === 'circle-x' ? '✕' : row.status === 'approved' ? '✓' : '⏳'}{' '}
              {t(`asbuilt.own.status.${row.status}`)}
            </Text>
            {row.reason ? (
              <Text style={{ color: theme.danger }}>
                {t('asbuilt.own.reason', { reason: row.reason })}
              </Text>
            ) : null}
            {row.syncRejection ? (
              <Text style={{ color: theme.danger }}>{t(rejectionKey(row.syncRejection))}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, paddingTop: spacing.lg },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  row: { borderWidth: 2, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  rowTitle: { fontWeight: '600' },
});
