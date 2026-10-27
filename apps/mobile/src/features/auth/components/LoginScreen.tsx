import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { spacing, typography } from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { LanguageSwitcher } from '../../../shared/ui/LanguageSwitcher';
import { TextField } from '../../../shared/ui/TextField';
import { useTheme } from '../../../shared/ui/theme';
import { useLoginForm } from '../hooks/useLoginForm';

export function LoginScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const form = useLoginForm();

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: theme.text }]}>{t('auth.title')}</Text>

      <TextField
        testID="login-email"
        label={t('auth.email')}
        value={form.email}
        onChangeText={form.setEmail}
        keyboardType="email-address"
        autoComplete="email"
        ltr
        error={form.fieldErrors.email ? t(form.fieldErrors.email) : undefined}
      />
      <TextField
        testID="login-password"
        label={t('auth.password')}
        value={form.password}
        onChangeText={form.setPassword}
        secureTextEntry
        autoComplete="current-password"
        ltr
        error={form.fieldErrors.password ? t(form.fieldErrors.password) : undefined}
      />

      {form.submitError ? (
        <Text
          testID="login-error"
          accessibilityRole="alert"
          style={[styles.error, { color: theme.danger }]}
        >
          {t(form.submitError)}
        </Text>
      ) : null}

      <Button
        testID="login-submit"
        label={t('auth.submit')}
        onPress={() => void form.submit()}
        busy={form.submitting}
      />

      <View style={styles.footer}>
        <LanguageSwitcher />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  error: { fontSize: typography.size.md, fontWeight: '600' },
  footer: { marginTop: spacing.xl },
});
