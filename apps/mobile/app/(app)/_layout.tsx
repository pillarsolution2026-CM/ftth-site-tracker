import { Stack } from 'expo-router';
import { useAuth } from '../../src/features/auth/hooks/AuthProvider';

export default function AppLayout() {
  const { me } = useAuth();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      {/* A contractor account (ADR-053) never reaches projects, drawings, updates or sync. */}
      <Stack.Protected guard={!me?.contractor}>
        <Stack.Screen name="project/[projectId]" />
      </Stack.Protected>
    </Stack>
  );
}
