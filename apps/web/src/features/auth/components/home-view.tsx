'use client';

import Link from 'next/link';
import type { ErrorCode, MeResponse, Project } from '@ftth/shared';
import { useAdminProjects } from '@/features/admin/api/queries';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useHomeSession } from '../hooks/use-home-session';

interface HomeViewProps {
  me: MeResponse | null;
  loading: boolean;
  failureCode: ErrorCode | null;
  loggingOut: boolean;
  onLogout: () => void;
  /** Platform admins: every project. Null for non-admins, or if it failed (memberships are shown). */
  allProjects: Project[] | null;
  allProjectsLoading: boolean;
}

const LINK =
  'flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

/** One row per project; an admin sees every project, with their own roles where they have any. */
function projectRows(me: MeResponse, allProjects: Project[] | null) {
  const roles = new Map<string, MeResponse['memberships'][number]['role'][]>();
  for (const membership of me.memberships) {
    roles.set(membership.projectId, [...(roles.get(membership.projectId) ?? []), membership.role]);
  }
  const projects = allProjects
    ? allProjects.map((project) => ({ id: project.id, name: project.name }))
    : [...new Map(me.memberships.map((m) => [m.projectId, m.projectName]))].map(([id, name]) => ({
        id,
        name,
      }));
  return projects.map((project) => ({ ...project, roles: roles.get(project.id) ?? [] }));
}

/** Presentational home: greeting, role per project (every project for admins), logout. */
export function HomeView({
  me,
  loading,
  failureCode,
  loggingOut,
  onLogout,
  allProjects,
  allProjectsLoading,
}: HomeViewProps) {
  const { t, locale } = useI18n();

  if (failureCode) {
    return (
      <p role="alert" className="flex items-center gap-2">
        <span aria-hidden="true">⚠</span>
        <span>{t(`errors.${failureCode}`)}</span>
      </p>
    );
  }
  if (loading || !me) return <p role="status">{t('common.loading')}</p>;
  const rows = projectRows(me, allProjects);

  return (
    <Card className="w-full max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t('auth.welcome', { name: me.displayName })}</h1>
        <Button variant="outline" onClick={onLogout} disabled={loggingOut}>
          {t('common.logout')}
        </Button>
      </div>

      <h2 className="mt-6 mb-2 text-lg font-semibold">
        {me.isAdmin ? t('admin.allProjects') : t('home.projects')}
      </h2>
      {me.isAdmin ? (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
          <span>{t('roles.admin')}</span>
          <Link href={`/${locale}/admin/projects`} className={LINK}>
            {t('admin.openAdmin')}
          </Link>
        </div>
      ) : null}
      {allProjectsLoading ? (
        <p role="status">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p>{me.isAdmin ? t('admin.noProjects') : t('home.noProjects')}</p>
      ) : (
        <ul className="divide-y divide-(--color-border)">
          {rows.map((project) => (
            <li key={project.id} className="flex min-h-11 items-center justify-between gap-4 py-2">
              <Link href={`/${locale}/projects/${project.id}`} className={LINK}>
                {project.name}
              </Link>
              <span className="flex flex-wrap gap-1">
                {project.roles.map((role) => (
                  <span
                    key={role}
                    className="rounded-md border border-(--color-border) px-2 py-1 text-sm"
                  >
                    {t(`roles.${role}`)}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Container: wires the session hook into the view. */
export function Home() {
  const session = useHomeSession();
  const isAdmin = session.me?.isAdmin === true;
  const all = useAdminProjects(isAdmin);
  return (
    <HomeView
      {...session}
      allProjects={isAdmin ? (all.data?.items ?? null) : null}
      allProjectsLoading={isAdmin && all.isPending}
    />
  );
}
