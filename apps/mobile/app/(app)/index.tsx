import { useRouter } from 'expo-router';
import { HomeSwitch } from '../../src/features/contractor/components/HomeSwitch';
import { portalApi, portalCache } from '../../src/features/contractor/default-deps';

export default function Home() {
  const router = useRouter();
  return (
    <HomeSwitch
      portalApi={portalApi}
      portalCache={portalCache}
      onOpenProject={(projectId) =>
        router.push({ pathname: '/project/[projectId]', params: { projectId } })
      }
    />
  );
}
