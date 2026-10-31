import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ContractDetail } from '@/features/contracts/components/contract-detail';

export default async function AdminContractPage({
  params,
}: {
  params: Promise<{ contractId: string }>;
}) {
  const { contractId } = await params;
  if (!z.uuid().safeParse(contractId).success) notFound();
  return <ContractDetail contractId={contractId} />;
}
