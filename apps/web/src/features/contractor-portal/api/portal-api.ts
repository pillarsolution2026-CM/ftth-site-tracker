import { ContractorPortalResponseSchema, type ContractorPortalResponse } from '@ftth/shared';
import { bffJson } from '@/shared/api/bff-client';

/** GET /contractor/me through the BFF: everything the contractor account may see. */
export function getContractorPortal(): Promise<ContractorPortalResponse> {
  return bffJson('/api/contractor/me', ContractorPortalResponseSchema);
}
