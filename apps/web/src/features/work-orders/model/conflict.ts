import { WORK_ORDER_CONFLICT_REASONS, type WorkOrderConflictReason } from '@ftth/shared';
import { ApiClientError } from '@/shared/api/bff-client';

export interface WorkOrderConflict {
  reason: WorkOrderConflictReason;
  /** Message params: only the strings the API sent (code and the quantity figures). */
  params: Record<string, string>;
}

const PARAM_KEYS = [
  'code',
  'contractQuantity',
  'reservedQuantity',
  'requestedQuantity',
  'availableQuantity',
] as const;

/** The ADR-028 409 reason of a failed work-order call, or null for any other error. */
export function workOrderConflictOf(error: unknown): WorkOrderConflict | null {
  if (!(error instanceof ApiClientError) || error.code !== 'CONFLICT') return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  const reason = WORK_ORDER_CONFLICT_REASONS.find((candidate) => candidate === record.reason);
  if (!reason) return null;
  const params: Record<string, string> = {};
  for (const key of PARAM_KEYS) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
  }
  return { reason, params };
}
