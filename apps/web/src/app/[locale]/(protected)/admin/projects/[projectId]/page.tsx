import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ProjectAdmin } from '@/features/admin/components/project-admin';

export default async function AdminProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) notFound();
  return <ProjectAdmin projectId={projectId} />;
}
