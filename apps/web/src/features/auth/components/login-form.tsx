'use client';

import type { ChangeEvent, FormEvent } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useLoginForm } from '../hooks/use-login-form';
import type { LoginFieldErrors, LoginValues } from '../model/login-validation';

interface LoginFormViewProps {
  values: LoginValues;
  fieldErrors: LoginFieldErrors;
  serverErrorKey: MessageKey | null;
  pending: boolean;
  onChange: (field: keyof LoginValues) => (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent) => void;
}

/** Presentational: props in, events out. */
export function LoginFormView({
  values,
  fieldErrors,
  serverErrorKey,
  pending,
  onChange,
  onSubmit,
}: LoginFormViewProps) {
  const { t } = useI18n();
  const emailError = fieldErrors.email;
  const passwordError = fieldErrors.password;

  return (
    <Card className="w-full max-w-md">
      <h1 className="mb-4 text-xl font-semibold">{t('auth.title')}</h1>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {serverErrorKey ? (
          <p
            role="alert"
            className="flex items-center gap-2 border-s-4 border-(--status-rejected) ps-3 text-sm"
          >
            <span aria-hidden="true">⚠</span>
            <span>{t(serverErrorKey)}</span>
          </p>
        ) : null}
        <Input
          id="email"
          name="email"
          type="email"
          dir="ltr"
          autoComplete="username"
          label={t('auth.email')}
          value={values.email}
          onChange={onChange('email')}
          error={emailError ? t(emailError) : undefined}
        />
        <Input
          id="password"
          name="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          label={t('auth.password')}
          value={values.password}
          onChange={onChange('password')}
          error={passwordError ? t(passwordError) : undefined}
        />
        <Button type="submit" disabled={pending}>
          {pending ? t('common.loading') : t('auth.submit')}
        </Button>
      </form>
    </Card>
  );
}

/** Container: wires the form hook into the view. */
export function LoginForm() {
  return <LoginFormView {...useLoginForm()} />;
}
