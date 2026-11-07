import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ContractorImport } from '@/features/contractors/components/contractor-import';

export default async function AdminContractorImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ registrationId?: string }>;
}) {
  const { projectId } = await params;
  const { registrationId } = await searchParams;
  if (!z.uuid().safeParse(projectId).success) notFound();
  if (registrationId !== undefined && !z.uuid().safeParse(registrationId).success) notFound();
  return <ContractorImport projectId={projectId} registrationId={registrationId} />;
}
