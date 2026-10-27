import { notFound } from 'next/navigation';
import { z } from 'zod';
import { WorkOrderDetail } from '@/features/work-orders/components/work-order-detail';

export default async function WorkOrderPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; workOrderId: string }>;
}) {
  const { locale, projectId, workOrderId } = await params;
  if (!z.uuid().safeParse(workOrderId).success) notFound();
  return (
    <WorkOrderDetail
      projectId={projectId}
      workOrderId={workOrderId}
      listPath={`/${locale}/projects/${projectId}/work-orders`}
    />
  );
}
