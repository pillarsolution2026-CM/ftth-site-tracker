import type { ReactNode } from 'react';
import { ContractorGuard } from '@/features/auth/components/contractor-guard';

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return <ContractorGuard>{children}</ContractorGuard>;
}
