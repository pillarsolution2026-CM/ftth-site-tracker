import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ITEM_A, ITEM_B, availabilityResponse } from '@/test-utils/work-orders';
import { useLinePicker } from '../hooks/use-line-picker';
import { ContractItemPicker } from './contract-item-picker';

const ITEMS = availabilityResponse().items;

function Harness({ disabled = [] as string[] }: { disabled?: string[] }) {
  const picker = useLinePicker(ITEMS);
  return (
    <ContractItemPicker
      total={ITEMS.length}
      rows={picker.rows}
      search={picker.search}
      onSearch={picker.setSearch}
      disabledIds={new Set(disabled)}
      checkOf={picker.checkOf}
      onToggle={picker.toggle}
      onQuantity={picker.setQuantity}
    />
  );
}

describe('ContractItemPicker', () => {
  it('shows contract, reserved and available quantities per item, LTR for codes and numbers', () => {
    renderScreen(<Harness />);
    const row = screen.getByRole('row', { name: /A-1/ });
    const cells = within(row).getAllByRole('cell');
    // choose, code, description, unit, work type, price, contract, reserved, available, quantity
    expect(cells[1]).toHaveTextContent('A-1');
    expect(within(row).getByText('A-1').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(cells[5]).toHaveTextContent('8,000.00');
    expect(cells[6]).toHaveTextContent('100');
    expect(cells[7]).toHaveTextContent('30');
    expect(cells[8]).toHaveTextContent('70');
  });

  it('searches by code or description', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);
    await user.type(screen.getByLabelText('Search items'), 'splice');
    expect(screen.queryByRole('row', { name: /A-1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /B-2/ })).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search items'));
    await user.type(screen.getByLabelText('Search items'), 'nothing like this');
    expect(screen.getByText('No items match the search')).toBeInTheDocument();
  });

  it('warns, with text and an icon, when the quantity is above what is available', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);
    await user.click(screen.getByLabelText('Choose item A-1'));
    const input = screen.getByLabelText('Quantity for item A-1');
    await user.type(input, '70');
    expect(screen.queryByText(/above what is available/)).not.toBeInTheDocument();
    await user.type(input, '.5');
    const warning = screen.getByText('Quantity is above what is available (70)');
    expect(warning.previousElementSibling).toHaveTextContent('▲');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('flags a missing or too precise quantity', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);
    await user.click(screen.getByLabelText('Choose item B-2'));
    expect(screen.getByText(/Enter a valid quantity/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Quantity for item B-2'), '1.23456');
    expect(screen.getByText(/Enter a valid quantity/)).toBeInTheDocument();
  });

  it('disables items that are already lines of the work order', () => {
    renderScreen(<Harness disabled={[ITEM_A]} />);
    expect(screen.getByLabelText('Choose item A-1')).toBeDisabled();
    expect(screen.getByLabelText('Choose item B-2')).toBeEnabled();
    expect(
      within(screen.getByRole('row', { name: /A-1/ })).getByText('In the work order'),
    ).toBeVisible();
    expect(ITEM_B).toBeTruthy();
  });
});
