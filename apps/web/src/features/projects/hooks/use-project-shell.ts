'use client';

import { useEffect, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAdminProjects } from '@/features/admin/api/queries';
import { useLogoutMutation, useMeQuery } from '@/features/auth/api/queries';
import { SessionApiError } from '@/features/auth/api/session-client';
import { useI18n } from '@/shared/i18n/locale-provider';
import { loginPath } from '@/shared/i18n/paths';
import {
  projectBasePath,
  resolveProjectAccess,
  visibleNavItems,
  type ProjectAccess,
} from '../model/project-access';

/** Session + project access for the project-scoped layout. */
export function useProjectShell(projectId: string) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const me = useMeQuery();
  const logout = useLogoutMutation();
  // Platform admins may open any project, so the switcher lists every project for them.
  const allProjects = useAdminProjects(me.data?.isAdmin === true);

  const unauthorized = me.error instanceof SessionApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace(loginPath(locale));
  }, [unauthorized, router, locale]);

  const access: ProjectAccess | null = useMemo(
    () => (me.data ? resolveProjectAccess(me.data, projectId) : null),
    [me.data, projectId],
  );

  const base = projectBasePath(locale, projectId);
  const navItems = useMemo(
    () =>
      access
        ? visibleNavItems(access).map((item) => {
            const href = `${base}/${item.segment}`;
            return {
              id: item.id,
              label: t(item.labelKey),
              href,
              active: pathname === href || pathname.startsWith(`${href}/`),
            };
          })
        : [],
    [access, base, pathname, t],
  );

  const projects = allProjects.data
    ? allProjects.data.items.map(({ id, name }) => ({ id, name }))
    : me.data?.memberships
      ? [
          ...new Map(
            me.data.memberships.map((membership) => [membership.projectId, membership.projectName]),
          ),
        ].map(([id, name]) => ({ id, name }))
      : [];

  const switchProject = (nextId: string) => {
    // Keep the section (work orders, CAD files) when moving to another project.
    const section = pathname.split('/')[4];
    router.push(`${projectBasePath(locale, nextId)}${section ? `/${section}` : ''}`);
  };

  const onLogout = () => {
    logout.mutate(undefined, { onSettled: () => router.replace(loginPath(locale)) });
  };

  const failed = me.error && !unauthorized;
  return {
    state: failed
      ? ('error' as const)
      : me.isPending || unauthorized || !access
        ? ('loading' as const)
        : access.status === 'not_member'
          ? ('forbidden' as const)
          : ('ready' as const),
    access,
    projectName:
      access?.status === 'member'
        ? (access.projectName ?? projects.find((project) => project.id === projectId)?.name ?? null)
        : null,
    projects,
    navItems,
    switchProject,
    onLogout,
    loggingOut: logout.isPending,
    displayName: me.data?.displayName ?? '',
  };
}
