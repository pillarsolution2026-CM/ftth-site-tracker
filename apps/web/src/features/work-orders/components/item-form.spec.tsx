import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkOrderItem } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { ItemForm } from './item-form';

const addMutate = vi.fn();
const updateMutate = vi.fn();
let addState: { isPending: boolean; error: unknown } = { isPending: false, error: null };

vi.mock('../api/queries', () => ({
  useAddItem: () => ({ mutate: addMutate, ...addState }),
  useUpdateItem: () => ({ mutate: updateMutate, isPending: false, error: null }),
}));

const WORK_ORDER_ID = '1f8fad5b-d9cb-469f-a165-70867728950e';

function existing(overrides: Partial<WorkOrderItem> = {}): WorkOrderItem {
  return {
    id: '2f8fad5b-d9cb-469f-a165-70867728950e',
    workOrderId: WORK_ORDER_ID,
    lineNo: 1,
    code: 'A-1',
    description: 'Trench',
    unit: 'm',
    quantity: '10',
    unitPrice: '2.5',
    amount: '25',
    source: 'manual',
    sourceRow: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function fill(code: string, quantity = '1', unitPrice = '1') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Code'), code);
  await user.type(screen.getByLabelText('Description'), 'Something');
  await user.type(screen.getByLabelText('Unit'), 'm');
  await user.type(screen.getByLabelText('Quantity'), quantity);
  await user.type(screen.getByLabelText('Unit price'), unitPrice);
  return user;
}

function renderForm(items: WorkOrderItem[] = [], editing?: WorkOrderItem) {
  const onDone = vi.fn();
  renderScreen(
    <ItemForm
      projectId={PROJECT_ID}
      workOrderId={WORK_ORDER_ID}
      items={items}
      editing={editing}
      onDone={onDone}
    />,
  );
  return onDone;
}

describe('ItemForm', () => {
  beforeEach(() => {
    addMutate.mockReset();
    updateMutate.mockReset();
    addState = { isPending: false, error: null };
  });

  it('validates required fields and decimal limits without sending', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Quantity'), '1.23456');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getAllByText('This field is required').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/at most 4 decimal places/)).toBeInTheDocument();
    expect(addMutate).not.toHaveBeenCalled();
  });

  it('sends amounts as exact strings and normalises Arabic digits', async () => {
    const user = await (async () => {
      renderForm();
      return fill('B-9', '١٢٫٥', '99999999999999.9999');
    })();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(addMutate).toHaveBeenCalledTimes(1);
    expect(addMutate.mock.calls[0]?.[0]).toEqual({
      code: 'B-9',
      description: 'Something',
      unit: 'm',
      quantity: '12.5',
      unitPrice: '99999999999999.9999',
      acceptDuplicateCode: false,
    });
  });

  it('asks before keeping a duplicate code and only then sends acceptDuplicateCode', async () => {
    renderForm([existing()]);
    const user = await fill('A-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Nothing sent yet: an explicit decision is required.
    expect(addMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Code A-1 already exists on lines 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep as a separate line' }));
    expect(addMutate).toHaveBeenCalledTimes(1);
    expect(addMutate.mock.calls[0]?.[0]).toMatchObject({ code: 'A-1', acceptDuplicateCode: true });
  });

  it('lets the user back out of a duplicate and change the code', async () => {
    renderForm([existing()]);
    const user = await fill('A-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Change the code' }));

    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Code'));
    await user.type(screen.getByLabelText('Code'), 'A-2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(addMutate.mock.calls[0]?.[0]).toMatchObject({ code: 'A-2', acceptDuplicateCode: false });
  });

  it('does not ask again when editing a line without changing its code', async () => {
    const line = existing();
    const other = existing({ id: '3f8fad5b-d9cb-469f-a165-70867728950e', lineNo: 2 });
    renderForm([line, other], line);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '11');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0]?.[0]).toMatchObject({
      itemId: line.id,
      body: { quantity: '11', acceptDuplicateCode: false },
    });
  });

  it('keeps code and numbers left-to-right', () => {
    renderForm();
    expect(screen.getByLabelText('Code')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('Unit price')).toHaveAttribute('dir', 'ltr');
  });
});
