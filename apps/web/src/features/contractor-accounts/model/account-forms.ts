import {
  CreateContractorAccountRequestSchema,
  type CreateContractorAccountInput,
} from '@ftth/shared';
import type { Locale, MessageKey } from '@ftth/i18n';

export type AccountField = 'email' | 'displayName' | 'password' | 'locale';
export type AccountFormValues = Record<AccountField, string>;

export const EMPTY_ACCOUNT_FORM: AccountFormValues = {
  email: '',
  displayName: '',
  password: '',
  locale: 'ar',
};

const MESSAGES: Record<AccountField, MessageKey> = {
  email: 'admin.validation.email',
  displayName: 'validation.required',
  password: 'admin.validation.password',
  locale: 'admin.validation.invalid',
};

export type AccountFormResult =
  | { ok: true; payload: CreateContractorAccountInput }
  | { ok: false; errors: Partial<Record<AccountField, MessageKey>> };

/** Same rules as an admin-created user (the shared request schema): password 12 to 128 characters. */
export function validateAccountForm(values: AccountFormValues): AccountFormResult {
  const input: CreateContractorAccountInput = {
    ...values,
    email: values.email.trim(),
    locale: values.locale as Locale,
  };
  const parsed = CreateContractorAccountRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, payload: input };
  const errors: Partial<Record<AccountField, MessageKey>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && field in MESSAGES) {
      errors[field as AccountField] ??= MESSAGES[field as AccountField];
    }
  }
  return { ok: false, errors };
}
