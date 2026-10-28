import { notFound } from 'next/navigation';
import { z } from 'zod';
import { MappingScreen } from '@/features/cad-mapping/components/mapping-screen';

export default async function CadMappingPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; cadFileId: string }>;
}) {
  const { locale, projectId, cadFileId } = await params;
  if (!z.uuid().safeParse(cadFileId).success) notFound();
  return (
    <MappingScreen
      projectId={projectId}
      cadFileId={cadFileId}
      filePath={`/${locale}/projects/${projectId}/cad-files/${cadFileId}`}
    />
  );
}
