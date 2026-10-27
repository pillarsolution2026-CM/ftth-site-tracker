import { LoginRequestSchema, type LoginRequest } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';

export interface LoginValues {
  email: string;
  password: string;
}

export type LoginFieldErrors = Partial<Record<keyof LoginValues, MessageKey>>;

const FIELD_MESSAGES: Record<keyof LoginValues, MessageKey> = {
  email: 'auth.emailInvalid',
  password: 'auth.passwordTooShort',
};

/** Validates with the shared contract so the form and the API agree on the rules. */
export function validateLogin(
  values: LoginValues,
): { ok: true; data: LoginRequest } | { ok: false; errors: LoginFieldErrors } {
  const result = LoginRequestSchema.safeParse({
    email: values.email.trim(),
    password: values.password,
  });
  if (result.success) return { ok: true, data: result.data };

  const errors: LoginFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === 'email' || field === 'password') errors[field] = FIELD_MESSAGES[field];
  }
  return { ok: false, errors };
}
