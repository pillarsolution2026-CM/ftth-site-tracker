import { CreateWorkOrder } from '@/features/work-orders/components/create-work-order';

export default async function NewWorkOrderPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <CreateWorkOrder projectId={projectId} />;
}
