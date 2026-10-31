import { ProjectContract } from '@/features/contracts/components/project-contract';

export default async function ProjectContractPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectContract projectId={projectId} />;
}
