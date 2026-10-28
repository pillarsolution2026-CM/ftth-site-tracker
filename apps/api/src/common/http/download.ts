import type { Response } from 'express';
import type { Readable } from 'node:stream';
import type { ByteRange } from '../object-storage.port.js';

/** RFC 5987 `filename*` value: UTF-8 percent-encoding that also escapes ' ( ) *. */
export function encodeContentDispositionName(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export type RangedObjectResponse =
  | { kind: 'stream'; stream: Readable; sizeBytes: number; range: ByteRange | null }
  | { kind: 'unsatisfiable'; sizeBytes: number };

/**
 * Streams a stored object for range-reading clients (e.g. PMTiles): 200 for the whole object,
 * 206 + `Content-Range` for one range, 416 + `Content-Range: bytes * /size` when out of bounds.
 */
export function sendRangedObject(
  response: Response,
  result: RangedObjectResponse,
  contentType: string,
): void {
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'private, no-cache');
  if (result.kind === 'unsatisfiable') {
    response.setHeader('Content-Range', `bytes */${result.sizeBytes}`);
    response.status(416).end();
    return;
  }
  response.setHeader('Content-Type', contentType);
  if (result.range) {
    const { start, end } = result.range;
    response.status(206);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${result.sizeBytes}`);
    response.setHeader('Content-Length', String(end - start + 1));
  } else {
    response.setHeader('Content-Length', String(result.sizeBytes));
  }
  result.stream.on('error', (error) => response.destroy(error));
  result.stream.pipe(response);
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
