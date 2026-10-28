interface PgErrorLike {
  code?: string;
  constraint?: string;
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

/** True when a lock wait hit `lock_timeout` (55P03 lock_not_available). */
export function lockNotAvailable(error: unknown): boolean {
  return pgErrorOf(error)?.code === '55P03';
}
