import { notFound } from 'next/navigation';
import { z } from 'zod';
import { CadFileDetailScreen } from '@/features/cad-files/components/cad-file-detail';

export default async function CadFilePage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; cadFileId: string }>;
}) {
  const { locale, projectId, cadFileId } = await params;
  if (!z.uuid().safeParse(cadFileId).success) notFound();
  return (
    <CadFileDetailScreen
      projectId={projectId}
      cadFileId={cadFileId}
      listPath={`/${locale}/projects/${projectId}/cad-files`}
    />
  );
}
