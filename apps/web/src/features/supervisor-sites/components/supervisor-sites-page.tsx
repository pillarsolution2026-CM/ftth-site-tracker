'use client';

import { ErrorNotice } from '@/shared/ui/error-notice';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { SupervisorSitesPanel } from './supervisor-sites-panel';

/** Project section for the PM (and the admin): gives supervisors their sites (ADR-054). */
export function SupervisorSitesPage({ projectId }: { projectId: string }) {
  const { can } = useProject();
  if (!can('supervisor_sites:manage')) return <ErrorNotice code="FORBIDDEN" />;
  return (
    <div className="max-w-4xl">
      <SupervisorSitesPanel projectId={projectId} />
    </div>
  );
}
