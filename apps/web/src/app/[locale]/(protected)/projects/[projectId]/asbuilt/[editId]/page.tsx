import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EditDetailScreen } from '@/features/asbuilt-review/components/edit-detail';

export default async function AsBuiltEditPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; editId: string }>;
}) {
  const { locale, projectId, editId } = await params;
  if (!z.uuid().safeParse(editId).success) notFound();
  return (
    <EditDetailScreen
      projectId={projectId}
      editId={editId}
      listPath={`/${locale}/projects/${projectId}/asbuilt`}
    />
  );
}
