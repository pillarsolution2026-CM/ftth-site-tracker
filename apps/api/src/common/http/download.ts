import type { Response } from 'express';
import type { Readable } from 'node:stream';

/** RFC 5987 `filename*` value: UTF-8 percent-encoding that also escapes ' ( ) *. */
export function encodeContentDispositionName(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Streams a stored file as a download; the body is never buffered. */
export function sendDownload(
  response: Response,
  file: { stream: Readable; contentType: string; fileName: string; sizeBytes?: number },
): void {
  response.setHeader('Content-Type', file.contentType);
  response.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeContentDispositionName(file.fileName)}`,
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.sizeBytes !== undefined) response.setHeader('Content-Length', String(file.sizeBytes));
  file.stream.on('error', (error) => response.destroy(error));
  file.stream.pipe(response);
}
