import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import {
  ITEM_A,
  ITEM_B,
  LINE_A,
  WORK_ORDER_ID,
  availability,
  availabilityResponse,
  workOrderDetail,
  workOrderItem,
} from '@/test-utils/work-orders';
import { WorkOrderDetail } from './work-order-detail';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const getWorkOrder = vi.fn();
const getContractItems = vi.fn();
const addItem = vi.fn();
const updateItem = vi.fn();
vi.mock('../api/work-orders-api', () => ({
  getWorkOrder: (...args: unknown[]) => getWorkOrder(...args),
  getContractItems: (...args: unknown[]) => getContractItems(...args),
  addItem: (...args: unknown[]) => addItem(...args),
  updateItem: (...args: unknown[]) => updateItem(...args),
}));

const LEGACY = workOrderItem({
  id: 'c1000000-0000-4000-8000-000000000009',
  lineNo: 2,
  code: 'OLD-9',
  description: 'Old line',
  contractItemId: null,
});

beforeEach(() => {
  getWorkOrder.mockReset().mockResolvedValue(workOrderDetail([workOrderItem(), LEGACY]));
  getContractItems.mockReset().mockResolvedValue(
    availabilityResponse([
      availability({ workOrderItemId: LINE_A }),
      availability({
        contractItemId: ITEM_B,
        code: 'B-2',
        description: 'Splice',
        contractQuantity: '10',
        reservedQuantity: '0',
        availableQuantity: '10',
      }),
    ]),
  );
  addItem.mockReset().mockResolvedValue(workOrderItem());
  updateItem.mockReset().mockResolvedValue(workOrderItem());
});

function renderDetail() {
  return renderScreen(
    <WorkOrderDetail projectId={PROJECT_ID} workOrderId={WORK_ORDER_ID} listPath="/en/p" />,
  );
}

describe('WorkOrderDetail lines (ADR-028)', () => {
  it('shows the contract quantity and what is available after reservation per line', async () => {
    renderDetail();
    const row = await screen.findByRole('row', { name: /A-1/ });
    await waitFor(() => expect(within(row).getAllByRole('cell')).toHaveLength(11));
    const cells = within(row).getAllByRole('cell');
    expect(cells[5]).toHaveTextContent('20'); // quantity
    expect(cells[6]).toHaveTextContent('100'); // contract quantity
    expect(cells[7]).toHaveTextContent('70'); // available after reservation
  });

  it('marks a legacy line with a badge and gives it no edit action', async () => {
    renderDetail();
    const legacyRow = await screen.findByRole('row', { name: /OLD-9/ });
    expect(within(legacyRow).getByText('Legacy')).toBeInTheDocument();
    expect(within(legacyRow).queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(within(legacyRow).getByText('Legacy line: cannot be edited')).toBeInTheDocument();
    expect(within(legacyRow).getByRole('button', { name: 'Delete OLD-9' })).toBeEnabled();
    const normalRow = screen.getByRole('row', { name: /A-1/ });
    expect(within(normalRow).queryByText('Legacy')).not.toBeInTheDocument();
    expect(within(normalRow).getByRole('button', { name: 'Edit A-1' })).toBeEnabled();
  });

  it('edits only the quantity: the other fields are read-only and only the quantity is sent', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Edit A-1' }));
    const form = screen.getByRole('form', { name: 'Edit item' });
    expect(within(form).getAllByRole('textbox')).toHaveLength(1);
    expect(within(form).getByText('Trench')).toBeInTheDocument();

    const input = within(form).getByLabelText('Quantity');
    await user.clear(input);
    await user.type(input, '35.5');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    expect(updateItem).toHaveBeenCalledWith(PROJECT_ID, WORK_ORDER_ID, LINE_A, {
      quantity: '35.5',
    });
  });

  it('warns above available plus the line quantity, and shows the server 409 in words', async () => {
    updateItem.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        code: 'A-1',
        contractQuantity: '100',
        reservedQuantity: '30',
        requestedQuantity: '91',
        availableQuantity: '70',
      }),
    );
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Edit A-1' }));
    const form = screen.getByRole('form', { name: 'Edit item' });
    const input = within(form).getByLabelText('Quantity');
    await user.clear(input);
    await user.type(input, '90');
    expect(within(form).queryByText(/above what is available/)).not.toBeInTheDocument();
    await user.type(input, '.5');
    // 70 available + 20 held by the line = 90
    expect(within(form).getByText('Quantity is above what is available (90)')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'requested 91, available 70 (contract 100, reserved 30)',
    );
  });

  it('add line uses the contract picker with the items already in the order disabled', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    const panel = screen.getByRole('region', { name: 'Add item' });
    expect(within(panel).getByLabelText('Choose item A-1')).toBeDisabled();
    await user.click(within(panel).getByLabelText('Choose item B-2'));
    await user.type(within(panel).getByLabelText('Quantity for item B-2'), '3');
    await user.click(within(panel).getByRole('button', { name: 'Add the chosen items' }));
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1));
    expect(addItem).toHaveBeenCalledWith(PROJECT_ID, WORK_ORDER_ID, {
      contractItemId: ITEM_B,
      quantity: '3',
    });
  });

  it('shows CONTRACT_ITEM_REPEATED from the server when a line was added meanwhile', async () => {
    addItem.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'CONTRACT_ITEM_REPEATED' }),
    );
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Add item' }));
    const panel = screen.getByRole('region', { name: 'Add item' });
    await user.click(within(panel).getByLabelText('Choose item B-2'));
    await user.type(within(panel).getByLabelText('Quantity for item B-2'), '3');
    await user.click(within(panel).getByRole('button', { name: 'Add the chosen items' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The item is already a line of the work order.',
    );
    expect(ITEM_A).toBeTruthy();
  });
});
