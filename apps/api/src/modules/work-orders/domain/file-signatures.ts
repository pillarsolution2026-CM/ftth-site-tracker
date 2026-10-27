/** Magic-number checks for uploads (content is verified, not just the extension). */

/** OOXML (xlsx) is a zip archive: `PK\x03\x04`. */
export function hasZipSignature(head: Buffer): boolean {
  return (
    head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  );
}

/** PDF files start with `%PDF-`. */
export function hasPdfSignature(head: Buffer): boolean {
  return head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}
