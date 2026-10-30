import { useLocalSearchParams, useRouter } from 'expo-router';
import { CadScreen } from '../../../../src/features/cad/components/CadScreen';

export default function ProjectCad() {
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return (
    <CadScreen
      onUpdate={(featureId) =>
        router.push({
          pathname: '/project/[projectId]/update/[featureId]',
          params: { projectId, featureId },
        })
      }
      onOpenPending={() =>
        router.push({ pathname: '/project/[projectId]/pending', params: { projectId } })
      }
    />
  );
}
