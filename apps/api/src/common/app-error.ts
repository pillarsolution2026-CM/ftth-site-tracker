import type { ErrorCode } from '@ftth/shared';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  REFRESH_TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNSUPPORTED_FILE: 415,
  FILE_TOO_LARGE: 413,
  IMPORT_INVALID: 422,
  INTERNAL: 500,
};

/** Error with a stable, client-facing code. Use cases throw it; the exception filter maps it to HTTP. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
    /** Overrides the default status of `code`, e.g. 422 for a semantically invalid VALIDATION_FAILED. */
    private readonly statusOverride?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get httpStatus(): number {
    return this.statusOverride ?? STATUS_BY_CODE[this.code];
  }
}

export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
