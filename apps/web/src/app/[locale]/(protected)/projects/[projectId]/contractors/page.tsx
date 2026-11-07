import { ProjectContractors } from '@/features/contractors/components/project-contractors';

export default async function ProjectContractorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectContractors projectId={projectId} />;
}
