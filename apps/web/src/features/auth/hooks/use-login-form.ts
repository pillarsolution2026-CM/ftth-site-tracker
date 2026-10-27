'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import { homePath } from '@/shared/i18n/paths';
import { useLoginMutation } from '../api/queries';
import { SessionApiError } from '../api/session-client';
import { validateLogin, type LoginFieldErrors, type LoginValues } from '../model/login-validation';

export function useLoginForm() {
  const { locale } = useI18n();
  const router = useRouter();
  const login = useLoginMutation();
  const [values, setValues] = useState<LoginValues>({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});

  const onChange = (field: keyof LoginValues) => (event: ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateLogin(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    login.mutate(result.data, { onSuccess: () => router.replace(homePath(locale)) });
  };

  const errorCode =
    login.error instanceof SessionApiError ? login.error.code : login.error ? 'INTERNAL' : null;
  const serverErrorKey: MessageKey | null = errorCode ? `errors.${errorCode}` : null;

  return {
    values,
    fieldErrors,
    serverErrorKey,
    pending: login.isPending,
    onChange,
    onSubmit,
  };
}
