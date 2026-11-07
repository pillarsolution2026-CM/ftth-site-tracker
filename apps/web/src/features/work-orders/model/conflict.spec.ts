import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { workOrderConflictOf } from './conflict';

describe('workOrderConflictOf', () => {
  it('recognises the ADR-036 contractor reasons with their figures', () => {
    const below = workOrderConflictOf(
      new ApiClientError('CONFLICT', 409, {
        reason: 'QUANTITY_BELOW_CONTRACTORS',
        code: 'C-001',
        contractorsQuantity: '30',
        requestedQuantity: '20',
      }),
    );
    expect(below).toEqual({
      reason: 'QUANTITY_BELOW_CONTRACTORS',
      params: { code: 'C-001', contractorsQuantity: '30', requestedQuantity: '20' },
    });
    for (const reason of ['LINE_HAS_CONTRACTORS', 'WORK_ORDER_HAS_CONTRACTORS']) {
      expect(workOrderConflictOf(new ApiClientError('CONFLICT', 409, { reason }))?.reason).toBe(
        reason,
      );
    }
  });

  it('still ignores unknown reasons and other errors', () => {
    expect(workOrderConflictOf(new ApiClientError('CONFLICT', 409, { reason: 'X' }))).toBeNull();
    expect(workOrderConflictOf(new ApiClientError('NOT_FOUND', 404))).toBeNull();
  });
});
