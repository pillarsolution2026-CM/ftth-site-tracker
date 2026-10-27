import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ProjectShell } from '@/features/projects/components/project-shell';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) notFound();
  return <ProjectShell projectId={projectId}>{children}</ProjectShell>;
}
