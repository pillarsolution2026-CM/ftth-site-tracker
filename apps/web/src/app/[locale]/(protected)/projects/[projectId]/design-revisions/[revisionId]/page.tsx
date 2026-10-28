import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DesignRevisionDetailScreen } from '@/features/design-revisions/components/design-revision-detail';

export default async function DesignRevisionPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; revisionId: string }>;
}) {
  const { locale, projectId, revisionId } = await params;
  if (!z.uuid().safeParse(revisionId).success) notFound();
  return (
    <DesignRevisionDetailScreen
      projectId={projectId}
      revisionId={revisionId}
      listPath={`/${locale}/projects/${projectId}/design-revisions`}
    />
  );
}
