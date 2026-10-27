import Busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { AppError } from '../app-error.js';

const MAX_FIELDS = 10;
const MAX_FIELD_BYTES = 1024 * 1024;

export interface StreamedFile {
  fileName: string;
  mimeType: string;
  stream: Readable;
}

export interface BufferedFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface MultipartUpload<F> {
  /** Text fields that arrived before the file (streamed mode) or all of them (buffered mode). */
  fields: Record<string, string>;
  file: F;
}

/** Client-supplied names are display data only: strip paths and control characters, cap the length. */
export function safeFileName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'upload').slice(0, 255);
}

function openParser(request: IncomingMessage, maxFileBytes: number): Busboy.Busboy {
  try {
    return Busboy({
      headers: request.headers,
      defParamCharset: 'utf8', // Arabic file names
      // One byte over the limit, so the size check downstream can tell "exactly max" from "too big".
      limits: {
        files: 1,
        fields: MAX_FIELDS,
        fieldSize: MAX_FIELD_BYTES,
        fileSize: maxFileBytes + 1,
      },
    });
  } catch {
    throw new AppError('UNSUPPORTED_FILE', 'Expected a multipart/form-data upload');
  }
}

/**
 * Hands the `file` part over as a stream while the request is still arriving. The caller must
 * consume it (the use case streams it into ObjectStorage). Text fields are available only if they
 * were sent before the file.
 */
export function receiveStreamedFile(
  request: IncomingMessage,
  maxFileBytes: number,
): Promise<MultipartUpload<StreamedFile>> {
  return new Promise((resolve, reject) => {
    let parser: Busboy.Busboy;
    try {
      parser = openParser(request, maxFileBytes);
    } catch (error) {
      reject(error);
      return;
    }
    const fields: Record<string, string> = {};
    let current: Readable | undefined;

    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || current) {
        stream.resume();
        return;
      }
      current = stream;
      resolve({
        fields,
        file: { fileName: safeFileName(info.filename), mimeType: info.mimeType, stream },
      });
    });
    parser.on('error', (error) => {
      current?.destroy(error instanceof Error ? error : new Error(String(error)));
      reject(new AppError('VALIDATION_FAILED', 'Malformed multipart request'));
    });
    parser.on('close', () => {
      if (!current) reject(new AppError('VALIDATION_FAILED', 'Multipart field "file" is required'));
    });
    request.pipe(parser);
  });
}

/** Reads the whole upload into memory; only for files that are parsed in memory anyway (xlsx). */
export function receiveBufferedFile(
  request: IncomingMessage,
  maxFileBytes: number,
): Promise<MultipartUpload<BufferedFile>> {
  return new Promise((resolve, reject) => {
    let parser: Busboy.Busboy;
    try {
      parser = openParser(request, maxFileBytes);
    } catch (error) {
      reject(error);
      return;
    }
    const fields: Record<string, string> = {};
    let file: BufferedFile | undefined;
    let tooLarge = false;

    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || file) {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxFileBytes) {
          tooLarge = true;
          chunks.length = 0; // stop holding memory; busboy truncates at limit + 1
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        file = {
          fileName: safeFileName(info.filename),
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
        };
      });
    });
    parser.on('error', () =>
      reject(new AppError('VALIDATION_FAILED', 'Malformed multipart request')),
    );
    parser.on('close', () => {
      if (tooLarge) {
        reject(new AppError('FILE_TOO_LARGE', `Upload exceeds ${maxFileBytes} bytes`));
      } else if (!file) {
        reject(new AppError('VALIDATION_FAILED', 'Multipart field "file" is required'));
      } else {
        resolve({ fields, file });
      }
    });
    request.pipe(parser);
  });
}
