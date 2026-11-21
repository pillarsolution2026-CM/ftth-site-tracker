import { useQuery } from '@tanstack/react-query';
import { getContractorPortal } from './portal-api';

export const contractorPortalKey = ['contractor', 'me'] as const;

export function useContractorPortal() {
  return useQuery({ queryKey: contractorPortalKey, queryFn: getContractorPortal, retry: false });
}
