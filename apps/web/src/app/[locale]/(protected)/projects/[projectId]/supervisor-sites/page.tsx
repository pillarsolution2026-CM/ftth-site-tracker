import { SupervisorSitesPage } from '@/features/supervisor-sites/components/supervisor-sites-page';

export default async function ProjectSupervisorSitesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <SupervisorSitesPage projectId={projectId} />;
}
