import { DesignRevisionList } from '@/features/design-revisions/components/design-revision-list';

export default async function DesignRevisionsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <DesignRevisionList projectId={projectId} />;
}
