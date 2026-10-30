import { useRouter } from 'expo-router';
import { ProjectsScreen } from '../../src/features/projects/components/ProjectsScreen';

export default function Home() {
  const router = useRouter();
  return (
    <ProjectsScreen
      onOpen={(projectId) =>
        router.push({ pathname: '/project/[projectId]', params: { projectId } })
      }
    />
  );
}
