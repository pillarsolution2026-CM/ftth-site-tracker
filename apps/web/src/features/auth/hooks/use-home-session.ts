'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/shared/i18n/locale-provider';
import { loginPath } from '@/shared/i18n/paths';
import { useLogoutMutation, useMeQuery } from '../api/queries';
import { SessionApiError } from '../api/session-client';

/** Loads the signed-in user, sends visitors with a dead session to the login page, handles logout. */
export function useHomeSession() {
  const { locale } = useI18n();
  const router = useRouter();
  const me = useMeQuery();
  const logout = useLogoutMutation();

  const unauthorized = me.error instanceof SessionApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace(loginPath(locale));
  }, [unauthorized, router, locale]);

  const onLogout = () => {
    logout.mutate(undefined, { onSettled: () => router.replace(loginPath(locale)) });
  };

  const failureCode = me.error instanceof SessionApiError && !unauthorized ? me.error.code : null;

  return {
    me: me.data ?? null,
    loading: me.isPending || unauthorized,
    failureCode: me.error && !unauthorized ? (failureCode ?? 'INTERNAL') : null,
    loggingOut: logout.isPending,
    onLogout,
  };
}
