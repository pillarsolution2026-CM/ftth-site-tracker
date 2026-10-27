import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LOCALES, type Locale } from '@ftth/i18n';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import { useI18n } from '../i18n/I18nProvider';
import { useTheme } from './theme';

const LABELS: Record<Locale, string> = { ar: 'العربية', en: 'English', fr: 'Français' };

export function LanguageSwitcher() {
  const { locale, setLocale, needsRestart, t } = useI18n();
  const theme = useTheme();
  return (
    <View style={styles.wrapper}>
      <Text style={[styles.title, { color: theme.text }]}>{t('common.language')}</Text>
      <View style={styles.row}>
        {LOCALES.map((code) => {
          const selected = code === locale;
          return (
            <Pressable
              key={code}
              testID={`lang-${code}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => void setLocale(code)}
              style={[
                styles.chip,
                {
                  borderColor: selected ? theme.brand : theme.border,
                  backgroundColor: selected ? theme.brand : 'transparent',
                },
              ]}
            >
              <Text
                style={{ color: selected ? theme.brandContrast : theme.text, fontWeight: '600' }}
              >
                {LABELS[code]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {needsRestart ? (
        <Text accessibilityRole="alert" style={[styles.notice, { color: theme.text }]}>
          {t('common.restartToApplyDirection')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.sm },
  title: { fontSize: typography.size.md, fontWeight: '600' },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.lg,
    borderWidth: 2,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { fontSize: typography.size.sm },
});
