import { WorkOrderList } from '@/features/work-orders/components/work-order-list';

export default async function WorkOrdersPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <WorkOrderList projectId={projectId} />;
}
