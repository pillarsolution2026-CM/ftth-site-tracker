import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { minTouchTarget, radius, spacing, typography } from '@ftth/ui-tokens';
import { useTheme } from './theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  busy?: boolean;
  testID?: string;
}

/** Primary buttons are large (56dp); every variant meets the 44dp minimum touch target. */
export function Button({ label, onPress, variant = 'primary', busy = false, testID }: ButtonProps) {
  const theme = useTheme();
  const primary = variant === 'primary';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: primary ? 56 : minTouchTarget,
          backgroundColor: primary ? theme.brand : 'transparent',
          borderColor: primary ? theme.brand : theme.text,
          opacity: pressed || busy ? 0.8 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? theme.brandContrast : theme.text} />
      ) : (
        <Text
          style={[
            styles.label,
            { color: primary ? theme.brandContrast : theme.text },
            primary && styles.primaryLabel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 2,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: typography.size.md, fontWeight: '600' },
  primaryLabel: { fontSize: typography.size.lg, fontWeight: '700' },
});
