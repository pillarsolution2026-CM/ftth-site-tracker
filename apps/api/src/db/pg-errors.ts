interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

/** drizzle wraps driver errors in `cause`; the original pg error carries `code` and `constraint`. */
function pgErrorOf(error: unknown): PgErrorLike | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof (current as PgErrorLike).code === 'string') {
      return current as PgErrorLike;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Name of the violated unique constraint, or null when `error` is not a unique violation (23505). */
export function uniqueViolation(error: unknown): string | null {
  const pgError = pgErrorOf(error);
  return pgError?.code === '23505' ? (pgError.constraint ?? '') : null;
}

/** Name of the violated foreign key, or null when `error` is not a foreign-key violation (23503). */
export function foreignKeyViolation(error: unknown): string | null {
  const pgError = pgErrorOf(error);
  return pgError?.code === '23503' ? (pgError.constraint ?? '') : null;
}

/** True for SQLSTATE 23001 (restrict_violation), raised by the DB triggers that lock approved data. */
export function restrictViolation(error: unknown): boolean {
  return pgErrorOf(error)?.code === '23001';
}

/**
 * Message of a check_violation (23514) or restrict_violation (23001) raised by a trigger, or null.
 * Used to turn the work-order line trigger of migration 0008 into a client-visible conflict.
 */
export function triggerViolationMessage(error: unknown): string | null {
  const pgError = pgErrorOf(error);
  return pgError?.code === '23514' || pgError?.code === '23001' ? (pgError.message ?? '') : null;
}

/** True when a lock wait hit `lock_timeout` (55P03 lock_not_available). */
export function lockNotAvailable(error: unknown): boolean {
  return pgErrorOf(error)?.code === '55P03';
}

/**
 * A plain error carrying only the operation, pg code and constraint. drizzle's query errors embed
 * the query parameters in their message; use this where a parameter is secret (password hashes).
 */
export function redactedDbError(error: unknown, operation: string): Error {
  const pgError = pgErrorOf(error);
  const detail = pgError
    ? `pg ${pgError.code ?? '?'}${pgError.constraint ? ` on ${pgError.constraint}` : ''}`
    : 'unknown cause';
  return new Error(`${operation} failed (${detail})`);
}
