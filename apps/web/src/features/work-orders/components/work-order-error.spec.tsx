import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { WorkOrderErrorNotice } from './work-order-error';

describe('WorkOrderErrorNotice with contractor conflicts (ADR-036)', () => {
  it('explains a quantity below the contractors in words with the numbers', () => {
    renderScreen(
      <WorkOrderErrorNotice
        error={
          new ApiClientError('CONFLICT', 409, {
            reason: 'QUANTITY_BELOW_CONTRACTORS',
            code: 'C-001',
            contractorsQuantity: '1030',
            requestedQuantity: '20',
          })
        }
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The quantity of item C-001 cannot go below what subcontractors hold: requested 20, held by subcontractors 1,030.',
    );
  });

  it.each([
    ['LINE_HAS_CONTRACTORS', 'This line is given to a subcontractor and cannot be removed.'],
    [
      'WORK_ORDER_HAS_CONTRACTORS',
      'Subcontractors are registered on this work order. Remove them first.',
    ],
  ])('explains %s', (reason, message) => {
    renderScreen(<WorkOrderErrorNotice error={new ApiClientError('CONFLICT', 409, { reason })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});
