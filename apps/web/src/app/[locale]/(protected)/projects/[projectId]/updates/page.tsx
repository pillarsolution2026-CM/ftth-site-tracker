import { UpdateList } from '@/features/execution-updates/components/update-list';

export default async function UpdatesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <UpdateList projectId={projectId} />;
}
