import { EditList } from '@/features/asbuilt-review/components/edit-list';

export default async function AsBuiltPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <EditList projectId={projectId} />;
}
