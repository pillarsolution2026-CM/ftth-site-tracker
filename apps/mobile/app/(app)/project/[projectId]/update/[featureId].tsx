import { useMemo } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../../../src/features/auth/hooks/AuthProvider';
import { usePhotoCapture } from '../../../../../src/features/camera/hooks/usePhotoCapture';
import { useField } from '../../../../../src/features/sync/hooks/FieldProvider';
import { UpdateWizardScreen } from '../../../../../src/features/update/components/UpdateWizardScreen';
import { currentGpsFix } from '../../../../../src/shared/device/location';

export default function UpdateFeature() {
  const router = useRouter();
  const { featureId } = useLocalSearchParams<{ featureId: string }>();
  const { bundle } = useField();
  const { me } = useAuth();
  const { composer, capture } = usePhotoCapture();
  const feature = bundle?.features.find((candidate) => candidate.id === featureId);
  const deps = useMemo(
    () => ({
      capturePhoto: capture,
      locate: () => currentGpsFix(),
      newId: () => Crypto.randomUUID(),
      now: () => new Date(),
      author: me?.displayName ?? '',
    }),
    [capture, me],
  );
  if (!feature) return null;
  return (
    <View style={{ flex: 1 }}>
      <UpdateWizardScreen
        feature={feature}
        deps={deps}
        onDone={() => router.back()}
        onCancel={() => router.back()}
      />
      {composer}
    </View>
  );
}
