import { LoginRequestSchema, type LoginRequest } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { ApiError } from '../api/api-client';

export interface LoginFieldErrors {
  email?: MessageKey;
  password?: MessageKey;
}

export type LoginValidation =
  { ok: true; value: LoginRequest } | { ok: false; errors: LoginFieldErrors };

/** Validates the form with the shared contract; returns i18n keys, never raw Zod messages. */
export function validateLogin(email: string, password: string): LoginValidation {
  const parsed = LoginRequestSchema.safeParse({ email: email.trim(), password });
  if (parsed.success) return { ok: true, value: parsed.data };

  const errors: LoginFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'email') errors.email = 'auth.emailInvalid';
    if (field === 'password') errors.password = 'auth.passwordTooShort';
  }
  return { ok: false, errors };
}

/** Maps any thrown error to an `errors.<code>` message key. */
export function errorKeyOf(error: unknown): MessageKey {
  const code = error instanceof ApiError ? error.code : 'INTERNAL';
  return `errors.${code}` as MessageKey;
}
