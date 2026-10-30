import { Stack, useLocalSearchParams } from 'expo-router';
import { FieldProvider } from '../../../../src/features/sync/hooks/FieldProvider';
import { nativeFieldDeps } from '../../../../src/features/sync/hooks/native-field-deps';

/** Everything under a project shares one outbox, offline bundle and sync scheduler. */
export default function ProjectLayout() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return (
    <FieldProvider projectId={projectId} deps={nativeFieldDeps()}>
      <Stack screenOptions={{ headerShown: false }} />
    </FieldProvider>
  );
}
