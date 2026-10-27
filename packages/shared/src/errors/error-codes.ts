import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  /** Wrong file type or content does not match the declared type (HTTP 415). */
  'UNSUPPORTED_FILE',
  /** Upload exceeds MAX_UPLOAD_MB (HTTP 413). */
  'FILE_TOO_LARGE',
  /** Excel import commit rejected; `details` follows ImportInvalidDetailsSchema (HTTP 422). */
  'IMPORT_INVALID',
  'INTERNAL',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
