import { useMemo } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../../../src/features/auth/hooks/AuthProvider';
import { usePhotoCapture } from '../../../../../src/features/camera/hooks/usePhotoCapture';
import { UpdateWizardScreen } from '../../../../../src/features/update/components/UpdateWizardScreen';
import { currentGpsFix } from '../../../../../src/shared/device/location';

/** The «التخطيط» button of a drawing (ADR-056): an update on the drawing, with no element. */
export default function UpdatePlanning() {
  const router = useRouter();
  const { drawingId } = useLocalSearchParams<{ drawingId: string }>();
  const { me } = useAuth();
  const { composer, capture } = usePhotoCapture();
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
  if (!drawingId) return null;
  return (
    <View style={{ flex: 1 }}>
      <UpdateWizardScreen
        target={{ kind: 'planning', drawingId }}
        deps={deps}
        onDone={() => router.back()}
        onCancel={() => router.back()}
      />
      {composer}
    </View>
  );
}
