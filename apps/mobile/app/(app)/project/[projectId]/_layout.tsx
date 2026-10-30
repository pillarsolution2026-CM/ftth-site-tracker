import { Stack, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../../src/features/auth/hooks/AuthProvider';
import { FieldProvider } from '../../../../src/features/sync/hooks/FieldProvider';
import { nativeFieldDeps } from '../../../../src/features/sync/hooks/native-field-deps';

/** Everything under a project shares one outbox, offline bundle and sync scheduler. */
export default function ProjectLayout() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { me } = useAuth();
  if (!me) return null;
  return (
    <FieldProvider projectId={projectId} userId={me.id} deps={nativeFieldDeps()}>
      <Stack screenOptions={{ headerShown: false }} />
    </FieldProvider>
  );
}
