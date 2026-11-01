import { useMemo } from 'react';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { AsBuiltDeps } from '../../../../src/features/asbuilt/hooks/useAsBuiltEditor';
import { CadScreen } from '../../../../src/features/cad/components/CadScreen';
import { currentGpsFix } from '../../../../src/shared/device/location';

export default function ProjectCad() {
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const asBuilt = useMemo<AsBuiltDeps>(
    () => ({
      newId: () => Crypto.randomUUID(),
      now: () => new Date(),
      locate: () => currentGpsFix(),
    }),
    [],
  );
  return (
    <CadScreen
      asBuilt={asBuilt}
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
