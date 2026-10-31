import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ContractImport } from '@/features/contracts/components/contract-import';

export default async function AdminContractImportPage({
  params,
}: {
  params: Promise<{ contractId: string }>;
}) {
  const { contractId } = await params;
  if (!z.uuid().safeParse(contractId).success) notFound();
  return <ContractImport contractId={contractId} />;
}
