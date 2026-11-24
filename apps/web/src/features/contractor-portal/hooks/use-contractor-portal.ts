'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLogoutMutation, useMeQuery } from '@/features/auth/api/queries';
import { errorCodeOf } from '@/shared/api/bff-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { loginPath } from '@/shared/i18n/paths';
import { useContractorPortal } from '../api/queries';
import {
  NO_FILTERS,
  filterWork,
  indexRegistrations,
  isStatusFilter,
  type PortalFilters,
} from '../model/portal-model';

/** The contractor's read-only data, the work-list filters and logout. */
export function useContractorPortalPage() {
  const { locale } = useI18n();
  const router = useRouter();
  const me = useMeQuery();
  const portal = useContractorPortal();
  const logout = useLogoutMutation();
  const [filters, setFilters] = useState<PortalFilters>(NO_FILTERS);
  const data = portal.data;

  const visibleWork = useMemo(() => (data ? filterWork(data.work, filters) : []), [data, filters]);
  const index = useMemo(() => indexRegistrations(data?.registrations ?? []), [data]);

  return {
    displayName: me.data?.displayName ?? '',
    loading: portal.isPending,
    errorCode: portal.error ? errorCodeOf(portal.error) : null,
    data: data ?? null,
    index,
    filters,
    visibleWork,
    onRegistrationFilter: (registrationId: string) =>
      setFilters((current) => ({ ...current, registrationId })),
    onStatusFilter: (status: string) =>
      setFilters((current) => ({ ...current, status: isStatusFilter(status) ? status : 'all' })),
    loggingOut: logout.isPending,
    onLogout: () =>
      logout.mutate(undefined, { onSettled: () => router.replace(loginPath(locale)) }),
  };
}

export type ContractorPortalModel = ReturnType<typeof useContractorPortalPage>;
