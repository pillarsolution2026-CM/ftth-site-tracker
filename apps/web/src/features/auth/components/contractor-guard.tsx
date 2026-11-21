'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMeQuery } from '../api/queries';
import { routeRedirect } from '../model/contractor-route';
import { useI18n } from '@/shared/i18n/locale-provider';

/**
 * Wraps every signed-in page (ADR-053). A contractor account is sent to his read-only page and
 * never sees the admin / PM pages, not even for a moment; other users cannot open his page.
 * While the session is loading, or when it failed, the page decides what to show.
 */
export function ContractorGuard({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const me = useMeQuery();
  const target = me.data ? routeRedirect(me.data, pathname, locale) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (me.isPending || target) return <p role="status">{t('contractorPortal.redirecting')}</p>;
  return <>{children}</>;
}
