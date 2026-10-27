import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { LanguageSwitcher } from '../../../shared/ui/LanguageSwitcher';
import { useTheme } from '../../../shared/ui/theme';
import { useAuth } from '../hooks/AuthProvider';

export function HomeScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { me, logout } = useAuth();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: theme.text }]}>
        {t('auth.welcome', { name: me?.displayName ?? '' })}
      </Text>

      <Text style={[styles.section, { color: theme.text }]}>{t('auth.projects')}</Text>
      {me && me.memberships.length > 0 ? (
        me.memberships.map((membership) => (
          <View key={membership.projectId} style={[styles.card, { borderColor: theme.border }]}>
            <Text style={[styles.projectName, { color: theme.text }]}>
              {membership.projectName}
            </Text>
            <Text style={{ color: theme.text }}>{t(`roles.${membership.role}`)}</Text>
          </View>
        ))
      ) : (
        <Text style={{ color: theme.text }}>{t('auth.noMemberships')}</Text>
      )}

      <LanguageSwitcher />
      <Button variant="secondary" label={t('common.logout')} onPress={() => void logout()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  section: { fontSize: typography.size.lg, fontWeight: '600' },
  card: { borderWidth: 2, borderRadius: radius.md, padding: spacing.lg, gap: spacing.xs },
  projectName: { fontSize: typography.size.lg, fontWeight: '600' },
});
