import { useRouter } from 'expo-router';
import { PendingScreen } from '../../../../src/features/sync/components/PendingScreen';

export default function Pending() {
  const router = useRouter();
  return <PendingScreen onBack={() => router.back()} />;
}
