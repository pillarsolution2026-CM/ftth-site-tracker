'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/shared/ui/button';
import { Select } from '@/shared/ui/form-controls';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { ProjectAccessProvider } from '../hooks/project-access-context';
import { useProjectShell } from '../hooks/use-project-shell';
import type { ProjectAccess } from '../model/project-access';

export interface ProjectShellViewProps {
  state: 'loading' | 'error' | 'forbidden' | 'ready';
  projectId: string;
  projectName: string | null;
  projects: { id: string; name: string }[];
  navItems: { id: string; label: string; href: string; active: boolean }[];
  loggingOut: boolean;
  onSwitchProject: (projectId: string) => void;
  onLogout: () => void;
  children: ReactNode;
}

/** Presentational: sidebar with project switcher and permission-filtered navigation. */
export function ProjectShellView({
  state,
  projectId,
  projectName,
  projects,
  navItems,
  loggingOut,
  onSwitchProject,
  onLogout,
  children,
}: ProjectShellViewProps) {
  const { t } = useI18n();

  if (state === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (state === 'error') return <Notice kind="error">{t('errors.INTERNAL')}</Notice>;
  if (state === 'forbidden') return <Notice kind="error">{t('project.notMember')}</Notice>;

  const hasCurrent = projects.some((project) => project.id === projectId);
  return (
    <div className="flex w-full flex-col gap-4 md:flex-row md:items-start">
      <aside className="flex shrink-0 flex-col gap-3 rounded-lg border border-(--color-border) p-3 md:sticky md:top-4 md:w-60">
        {projects.length > 0 ? (
          <Select
            id="project-switcher"
            label={t('project.switcher')}
            value={projectId}
            onChange={(event) => onSwitchProject(event.target.value)}
          >
            {hasCurrent ? null : <option value={projectId}>{projectName ?? projectId}</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        ) : projectName ? (
          <p className="font-semibold">{projectName}</p>
        ) : null}
        <nav aria-label={t('nav.menu')}>
          <ul className="m-0 flex list-none flex-row flex-wrap gap-1 p-0 md:flex-col">
            {navItems.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  className={
                    'flex min-h-11 items-center rounded-md px-3 ' +
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus) ' +
                    (item.active
                      ? 'bg-(--color-brand) font-semibold text-(--color-brandContrast)'
                      : 'text-(--color-brand) underline')
                  }
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Button variant="outline" onClick={onLogout} disabled={loggingOut}>
          {t('common.logout')}
        </Button>
      </aside>
      <section className="min-w-0 flex-1" aria-label={projectName ?? t('nav.content')}>
        {children}
      </section>
    </div>
  );
}

/** Container: session, access and navigation for one project. */
export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const shell = useProjectShell(projectId);
  const access: ProjectAccess = shell.access ?? { status: 'not_member' };
  return (
    <ProjectAccessProvider projectId={projectId} access={access}>
      <ProjectShellView
        state={shell.state}
        projectId={projectId}
        projectName={shell.projectName}
        projects={shell.projects}
        navItems={shell.navItems}
        loggingOut={shell.loggingOut}
        onSwitchProject={shell.switchProject}
        onLogout={shell.onLogout}
      >
        {children}
      </ProjectShellView>
    </ProjectAccessProvider>
  );
}
