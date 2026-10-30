import { Directory, File, Paths } from 'expo-file-system';

/** Photos stay in the app's document directory until the server confirms them (ADR-024). */
export function photoFile(photoId: string): File {
  const dir = new Directory(Paths.document, 'photos');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, `${photoId}.jpg`);
}

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

export function deleteFile(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}

export function fileSize(uri: string): number {
  return new File(uri).size;
}

export async function readJson(name: string): Promise<unknown> {
  const file = new File(Paths.document, name);
  if (!file.exists) return null;
  return JSON.parse(await file.text()) as unknown;
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  const file = new File(Paths.document, name);
  if (!file.exists) file.create({ intermediates: true });
  await file.write(JSON.stringify(value));
}
