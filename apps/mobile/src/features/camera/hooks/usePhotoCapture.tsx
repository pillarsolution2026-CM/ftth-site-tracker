import { useCallback, useRef, useState, type ComponentRef, type ReactElement } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { captureRef } from 'react-native-view-shot';
import type { GpsFix } from '@ftth/shared';
import { deviceVault } from '../../../shared/crypto/device-key';
import { deleteFile, photoFile } from '../../../shared/device/files';
import type { CapturedPhoto } from '../../update/model/update-wizard';
import {
  JPEG_QUALITY,
  targetSize,
  toHex,
  watermarkLines,
  type WatermarkInput,
} from '../model/photo-processing';

interface Composition {
  uri: string;
  width: number;
  height: number;
  lines: string[];
  loaded: () => void;
}

export interface CaptureRequest {
  requirementKey: string;
  watermark: Omit<WatermarkInput, 'takenAt' | 'gps'>;
  gps: GpsFix | null;
}

/**
 * Camera pipeline (plan): take the photo, resize to ≤ 1600 px, burn the watermark (feature, time,
 * GPS, author) into the pixels, save as JPEG 80 %, then hash the exact bytes that will be uploaded.
 * The watermark is drawn by an off-screen view captured with react-native-view-shot, so the
 * returned `composer` element must be rendered by the screen.
 */
export function usePhotoCapture(): {
  composer: ReactElement | null;
  capture(request: CaptureRequest): Promise<CapturedPhoto | null>;
} {
  const [composition, setComposition] = useState<Composition | null>(null);
  const viewRef = useRef<ComponentRef<typeof View>>(null);

  const capture = useCallback(async (request: CaptureRequest): Promise<CapturedPhoto | null> => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return null;
    const shot = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
      exif: false,
    });
    const asset = shot.canceled ? null : shot.assets[0];
    if (!asset) return null;

    const size = targetSize(asset.width, asset.height);
    const rendered = await ImageManipulator.ImageManipulator.manipulate(asset.uri)
      .resize(size)
      .renderAsync();
    const resized = await rendered.saveAsync({
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    });

    const takenAt = new Date();
    const lines = watermarkLines({ ...request.watermark, takenAt, gps: request.gps });
    await new Promise<void>((resolve) =>
      setComposition({
        uri: resized.uri,
        width: size.width,
        height: size.height,
        lines,
        loaded: resolve,
      }),
    );
    // view-shot's types predate React Native's element refs; the ref is a host view.
    const tmp = await captureRef(viewRef as unknown as Parameters<typeof captureRef>[0], {
      format: 'jpg',
      quality: JPEG_QUALITY,
      result: 'tmpfile',
      width: size.width,
      height: size.height,
    });
    setComposition(null);

    // Hash the exact JPEG that will be uploaded, then keep only a sealed copy (ADR-025).
    const shotFile = new File(tmp);
    const bytes = await shotFile.bytes();
    const sha256 = toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
    const photoId = Crypto.randomUUID();
    const target = photoFile(photoId);
    target.create({ intermediates: true });
    await target.write(await deviceVault().sealBytes(bytes));
    shotFile.delete();
    // No plain copy is left behind: the camera original and the resized image go too.
    deleteFile(resized.uri);
    deleteFile(asset.uri);
    return {
      photoId,
      requirementKey: request.requirementKey,
      fileUri: target.uri,
      sha256,
      sizeBytes: bytes.length,
      takenAt: takenAt.toISOString(),
      gps: request.gps,
    };
  }, []);

  const composer = composition ? (
    <View
      ref={viewRef}
      collapsable={false}
      pointerEvents="none"
      style={[styles.offscreen, { width: composition.width, height: composition.height }]}
    >
      <Image
        source={{ uri: composition.uri }}
        style={{ width: composition.width, height: composition.height }}
        onLoad={composition.loaded}
      />
      <View style={styles.band}>
        {composition.lines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  ) : null;

  return { composer, capture };
}

const styles = StyleSheet.create({
  // Rendered but outside the visible window.
  offscreen: { position: 'absolute', left: -10_000, top: 0 },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  line: { color: '#FFFFFF', fontSize: 34, fontWeight: '700', writingDirection: 'ltr' },
});
