import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { ITEM_A, ITEM_B, WORK_ORDER_ID, availabilityResponse } from '@/test-utils/work-orders';
import { CreateWorkOrder } from './create-work-order';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const listWorkOrders = vi.fn();
const getContractItems = vi.fn();
const createWorkOrder = vi.fn();
vi.mock('../api/work-orders-api', () => ({
  listWorkOrders: (...args: unknown[]) => listWorkOrders(...args),
  getContractItems: (...args: unknown[]) => getContractItems(...args),
  createWorkOrder: (...args: unknown[]) => createWorkOrder(...args),
}));

beforeEach(() => {
  push.mockReset();
  listWorkOrders.mockReset().mockResolvedValue({ items: [] });
  getContractItems.mockReset().mockResolvedValue(availabilityResponse());
  createWorkOrder.mockReset().mockResolvedValue({ id: WORK_ORDER_ID });
});

async function fillHeaderAndPick(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/^Number/), 'WO-5');
  await user.click(screen.getByLabelText('Choose item A-1'));
  await user.type(screen.getByLabelText('Quantity for item A-1'), '25');
  await user.click(screen.getByLabelText('Choose item B-2'));
  await user.type(screen.getByLabelText('Quantity for item B-2'), '4.5');
}

describe('CreateWorkOrder', () => {
  it('creates the work order from the chosen contract items and opens it', async () => {
    const user = userEvent.setup();
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    await fillHeaderAndPick(user);
    expect(screen.getByText('Items chosen: 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createWorkOrder).toHaveBeenCalledTimes(1));
    expect(createWorkOrder.mock.calls[0]).toEqual([
      PROJECT_ID,
      expect.objectContaining({
        number: 'WO-5',
        lines: [
          { contractItemId: ITEM_A, quantity: '25' },
          { contractItemId: ITEM_B, quantity: '4.5' },
        ],
      }),
    ]);
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/en/projects/${PROJECT_ID}/work-orders/${WORK_ORDER_ID}`),
    );
  });

  it('does not send while a chosen item has no valid quantity', async () => {
    const user = userEvent.setup();
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    await user.type(await screen.findByLabelText(/^Number/), 'WO-5');
    await user.click(screen.getByLabelText('Choose item A-1'));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it('explains QUANTITY_EXCEEDS_CONTRACT with contract, reserved, requested and available', async () => {
    createWorkOrder.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        contractItemId: ITEM_A,
        code: 'A-1',
        contractQuantity: '100',
        reservedQuantity: '30',
        requestedQuantity: '80',
        availableQuantity: '70',
      }),
    );
    const user = userEvent.setup();
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    await fillHeaderAndPick(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'item A-1: requested 80, available 70 (contract 100, reserved 30)',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('shows a plain number-taken error for a CONFLICT without a reason', async () => {
    createWorkOrder.mockRejectedValue(new ApiClientError('CONFLICT', 409));
    const user = userEvent.setup();
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    await fillHeaderAndPick(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('This number is already used in the project'),
    ).toBeInTheDocument();
  });

  it.each([
    ['NO_CONTRACT', 'This project has no contract. Create the contract first.'],
    ['CONTRACT_NOT_APPROVED', 'The contract is still a draft. Approve the contract first.'],
  ])('shows %s and no create form', async (reason, text) => {
    getContractItems.mockRejectedValue(new ApiClientError('CONFLICT', 409, { reason }));
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Number/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('links to the existing work order instead of a second one', async () => {
    listWorkOrders.mockResolvedValue({ items: [{ id: WORK_ORDER_ID, number: 'WO-1' }] });
    renderScreen(<CreateWorkOrder projectId={PROJECT_ID} />);
    expect(await screen.findByText('This project already has a work order.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the work order/ })).toHaveAttribute(
      'href',
      `/en/projects/${PROJECT_ID}/work-orders/${WORK_ORDER_ID}`,
    );
    expect(screen.queryByLabelText(/^Number/)).not.toBeInTheDocument();
  });
});
