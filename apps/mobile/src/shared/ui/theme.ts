import { useColorScheme } from 'react-native';
import { colors, statusTokens } from '@ftth/ui-tokens';

export interface Theme {
  dark: boolean;
  background: string;
  text: string;
  border: string;
  brand: string;
  brandContrast: string;
  focus: string;
  danger: string;
}

/** Day/night palette from the shared design tokens. Follows the system setting. */
export function useTheme(): Theme {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    background: dark ? colors.surfaceDark : colors.surface,
    text: dark ? colors.textDark : colors.text,
    border: colors.border,
    brand: colors.brand,
    brandContrast: colors.brandContrast,
    focus: colors.focus,
    danger: statusTokens.rejected.color,
  };
}
