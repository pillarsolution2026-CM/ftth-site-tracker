import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import { useAuth } from '../../auth/hooks/AuthProvider';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { LanguageSwitcher } from '../../../shared/ui/LanguageSwitcher';
import { useTheme } from '../../../shared/ui/theme';

/** Home: the projects the supervisor is assigned to; opening one goes to its CAD screen. */
export function ProjectsScreen({ onOpen }: { onOpen: (projectId: string) => void }) {
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
      <Text style={[styles.section, { color: theme.text }]}>{t('field.chooseProject')}</Text>
      {me && me.memberships.length > 0 ? (
        me.memberships.map((membership) => (
          <Pressable
            key={`${membership.projectId}-${membership.role}`}
            accessibilityRole="button"
            onPress={() => onOpen(membership.projectId)}
            style={[styles.card, { borderColor: theme.border }]}
            testID={`project-${membership.projectId}`}
          >
            <Text style={[styles.projectName, { color: theme.text }]}>
              {membership.projectName}
            </Text>
            <Text style={{ color: theme.text }}>{t(`roles.${membership.role}`)}</Text>
          </Pressable>
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
  card: {
    borderWidth: 2,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
    minHeight: minTouchTarget,
  },
  projectName: { fontSize: typography.size.lg, fontWeight: '600' },
});
