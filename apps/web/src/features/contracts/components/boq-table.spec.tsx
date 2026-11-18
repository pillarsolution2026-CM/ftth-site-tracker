import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { contractDetail, heading, pricedItem } from '@/test-utils/contract';
import { BoqTable } from './boq-table';

describe('BoqTable', () => {
  it('shows a heading as a bold section row spanning the data columns, without price cells', () => {
    renderScreen(<BoqTable contract={contractDetail()} />);
    const table = screen.getByRole('table', { name: 'BOQ (contract items)' });
    const row = within(table).getByText('Civil works').closest('tr');
    expect(row).toHaveAttribute('data-kind', 'heading');
    expect(row).toHaveClass('font-bold');
    // line, code and one spanning cell: no unit, quantity, price or amount cells
    expect(within(row as HTMLElement).getAllByRole('cell')).toHaveLength(3);
    expect(
      within(row as HTMLElement)
        .getByText('Civil works')
        .closest('td'),
    ).toHaveAttribute('colspan', '8');
    expect(within(row as HTMLElement).getByText('Section heading')).toBeInTheDocument();
  });

  it('indents each line by its depth from the parent code and keeps codes left-to-right', () => {
    renderScreen(<BoqTable contract={contractDetail()} />);
    const indentOf = (code: string) => {
      const cell = screen
        .getAllByText(code)
        .map((element) => element.closest('td') as HTMLElement)
        .find((td) => td.style.paddingInlineStart !== '');
      return cell?.style.paddingInlineStart;
    };
    expect(indentOf('1')).toBe('0.75rem');
    expect(indentOf('1-1')).toBe('2rem');
    expect(indentOf('1-1-1')).toBe('3.25rem');
    expect(screen.getByText('1-1-1').closest('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it('wraps long units in a bounded column and formats amounts exactly', () => {
    renderScreen(<BoqTable contract={contractDetail()} />);
    const unit = screen.getByText('BULDING (1 to 8)').closest('td');
    expect(unit).toHaveClass('max-w-48', 'min-w-24', 'wrap-break-word');
    expect(screen.getByText('27.50')).toBeInTheDocument();
  });

  it('totals the items only, with the currency', () => {
    renderScreen(<BoqTable contract={contractDetail({ total: '52.5' })} />);
    expect(screen.getByTestId('boq-total')).toHaveTextContent('52.50 EGP');
  });

  it('marks duplicate codes with a text badge', () => {
    const dup = contractDetail({
      items: [pricedItem(1, 'A-1'), pricedItem(2, 'A-1'), heading(3, 'B', null)],
      duplicateCodes: [{ code: 'A-1', lineNos: [1, 2] }],
    });
    renderScreen(<BoqTable contract={dup} />);
    expect(screen.getAllByText('Repeated code')).toHaveLength(2);
    expect(screen.getByText('(no title)')).toBeInTheDocument();
  });

  it('has no actions column for a read-only reader and offers edit and delete when editing', () => {
    const { unmount } = renderScreen(<BoqTable contract={contractDetail()} />);
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    unmount();

    const onEdit = vi.fn();
    renderScreen(
      <BoqTable
        contract={contractDetail()}
        editing={{
          confirmItemId: null,
          deleting: false,
          onEdit,
          onAskDelete: vi.fn(),
          onDelete: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Edit 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 1-1' })).toBeInTheDocument();
  });

  it('shows the groups with their source, and the rule value next to a manual choice', () => {
    const detail = contractDetail({
      items: [
        pricedItem(1, 'A', {
          group: {
            group: { main: 'Digging', sub: null },
            source: 'manual',
            ruleId: 'bundles',
            ruleGroup: { main: 'Bundles', sub: '12 tubes' },
          },
        }),
        pricedItem(2, 'B', {
          group: { group: null, source: 'none', ruleId: null, ruleGroup: null },
        }),
        pricedItem(3, 'C'),
      ],
      ungroupedItemCount: 1,
    });
    renderScreen(<BoqTable contract={detail} />);
    expect(screen.getByRole('columnheader', { name: 'Main work group' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sub work group' })).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('The rule gives: Bundles / 12 tubes')).toBeInTheDocument();
    expect(screen.getByText('No group')).toBeInTheDocument();
    expect(screen.getAllByText('Automatic')).toHaveLength(1);
  });

  it('can show only the lines without a group, and offers a group edit to an admin', () => {
    const detail = contractDetail({
      items: [
        pricedItem(1, 'A'),
        pricedItem(2, 'B', {
          group: { group: null, source: 'none', ruleId: null, ruleGroup: null },
        }),
      ],
      ungroupedItemCount: 1,
    });
    renderScreen(
      <BoqTable contract={detail} onlyUngrouped groupEditing={{ onEditGroup: vi.fn() }} />,
    );
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit group B' })).toBeInTheDocument();
    expect(screen.queryByTestId('boq-total')).not.toBeInTheDocument();
  });
});
