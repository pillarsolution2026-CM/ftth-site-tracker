import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { authApi } from '../src/features/auth/api/default-api';
import { AuthProvider, useAuth } from '../src/features/auth/hooks/AuthProvider';
import { I18nProvider } from '../src/shared/i18n/I18nProvider';
import { useTheme } from '../src/shared/ui/theme';

function Routes() {
  const { status } = useAuth();
  const theme = useTheme();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.background }}>
        <ActivityIndicator size="large" color={theme.brand} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'signedIn'}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signedOut'}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <I18nProvider>
      <AuthProvider api={authApi}>
        <StatusBar style="auto" />
        <Routes />
      </AuthProvider>
    </I18nProvider>
  );
}
