import type { ZodType } from 'zod';
import { AppError } from '../app-error.js';

/**
 * Parses the JSON `payload` text field of a multipart request with a shared schema.
 * A missing field yields `fallback` when given, otherwise a validation error.
 */
export function parsePayloadField<T>(
  fields: Record<string, string>,
  schema: ZodType<T>,
  fallback?: unknown,
): T {
  const text = fields.payload;
  let value: unknown = fallback;
  if (text !== undefined) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Field "payload" must be valid JSON');
    }
  } else if (fallback === undefined) {
    throw new AppError('VALIDATION_FAILED', 'Field "payload" is required');
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }
  return result.data;
}

export const maxUploadBytes = (maxUploadMb: number): number => maxUploadMb * 2 ** 20;
