import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import { useTheme } from './theme';

interface TextFieldProps extends Pick<
  TextInputProps,
  'value' | 'onChangeText' | 'secureTextEntry' | 'keyboardType' | 'autoComplete' | 'testID'
> {
  label: string;
  error?: string | undefined;
  /** Emails, passwords, codes and coordinates are always left-to-right. */
  ltr?: boolean;
}

export function TextField({ label, error, ltr = false, testID, ...input }: TextFieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.wrapper}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput
        {...input}
        testID={testID}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.border}
        style={[
          styles.input,
          {
            color: theme.text,
            borderColor: error ? theme.danger : theme.border,
            backgroundColor: theme.background,
          },
          ltr && styles.ltr,
        ]}
      />
      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.xs },
  label: { fontSize: typography.size.md, fontWeight: '600' },
  input: {
    minHeight: minTouchTarget + 8,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typography.size.lg,
  },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  error: { fontSize: typography.size.md, fontWeight: '600' },
});
