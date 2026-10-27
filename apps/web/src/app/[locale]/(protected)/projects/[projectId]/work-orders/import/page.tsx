import { ImportWizard } from '@/features/work-order-import/components/import-wizard';

export default async function ImportWorkOrderPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ImportWizard projectId={projectId} />;
}
