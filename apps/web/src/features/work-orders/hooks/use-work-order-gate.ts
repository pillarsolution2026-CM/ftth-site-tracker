'use client';

import type { ContractItemAvailabilityResponse, WorkOrderSummary } from '@ftth/shared';
import { errorCodeOf, errorReasonOf, type ClientErrorCode } from '@/shared/api/bff-client';
import { useProject } from '@/features/projects/hooks/project-access-context';
import { useContractItems, useWorkOrders } from '../api/queries';

export type GateBlock = 'NO_CONTRACT' | 'CONTRACT_NOT_APPROVED' | 'WORK_ORDER_EXISTS';

export type WorkOrderGate =
  | { status: 'loading' }
  | { status: 'error'; errorCode: ClientErrorCode }
  /** The project cannot get a (new) work order, for this reason (ADR-028 409 reasons). */
  | { status: 'blocked'; reason: GateBlock; workOrder: WorkOrderSummary | null }
  | { status: 'ready'; availability: ContractItemAvailabilityResponse };

/**
 * Whether the project can get its work order: one per project (ADR-028), and only under an
 * approved contract. Combines the work-order list with the contract-item availability, whose
 * 409 NO_CONTRACT / CONTRACT_NOT_APPROVED explain a missing contract.
 */
export function useWorkOrderGate(projectId: string): WorkOrderGate {
  const { can } = useProject();
  const canRead = can('work_orders:read');
  const canWrite = can('work_orders:write');
  const list = useWorkOrders(projectId, canRead);
  const availability = useContractItems(projectId, canWrite);

  if (list.error) return { status: 'error', errorCode: errorCodeOf(list.error) };
  const existing = list.data?.items[0] ?? null;
  if (existing) return { status: 'blocked', reason: 'WORK_ORDER_EXISTS', workOrder: existing };
  if (availability.error) {
    const reason = errorReasonOf(availability.error);
    if (reason === 'NO_CONTRACT' || reason === 'CONTRACT_NOT_APPROVED') {
      return { status: 'blocked', reason, workOrder: null };
    }
    return { status: 'error', errorCode: errorCodeOf(availability.error) };
  }
  if (!list.data || !availability.data) return { status: 'loading' };
  return { status: 'ready', availability: availability.data };
}
