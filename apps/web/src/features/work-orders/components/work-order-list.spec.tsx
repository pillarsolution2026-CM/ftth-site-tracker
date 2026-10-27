import { screen, within } from '@testing-library/react';
import type { WorkOrderSummary } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { WorkOrderListView } from './work-order-list';

function summary(overrides: Partial<WorkOrderSummary> = {}): WorkOrderSummary {
  return {
    id: '1f8fad5b-d9cb-469f-a165-70867728950e',
    projectId: PROJECT_ID,
    number: 'WO-2026-001',
    title: 'أمر تكليف',
    issuedOn: '2026-03-01',
    currency: 'EGP',
    source: 'import',
    itemCount: 12,
    total: '12345678901234.12345678',
    attachmentCount: 1,
    version: 3,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('WorkOrderListView', () => {
  it('shows the exact total with currency, LTR, without losing digits', () => {
    renderScreen(
      <WorkOrderListView basePath="/en/p" items={[summary()]} errorCode={null} canWrite />,
    );
    const total = screen.getByText('12,345,678,901,234.12345678 EGP');
    expect(total.closest('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it('renders the number as a link and the source as text', () => {
    renderScreen(
      <WorkOrderListView basePath="/en/p" items={[summary()]} errorCode={null} canWrite={false} />,
    );
    const row = screen.getByRole('row', { name: /WO-2026-001/ });
    expect(within(row).getByRole('link', { name: 'WO-2026-001' })).toHaveAttribute(
      'href',
      '/en/p/1f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(within(row).getByText('Excel import')).toBeInTheDocument();
  });

  it('offers create and import only with the write permission', () => {
    const { unmount } = renderScreen(
      <WorkOrderListView basePath="/en/p" items={[]} errorCode={null} canWrite />,
    );
    expect(screen.getByRole('link', { name: 'New work order' })).toHaveAttribute(
      'href',
      '/en/p/new',
    );
    expect(screen.getByRole('link', { name: 'Import from Excel' })).toBeInTheDocument();
    unmount();
    renderScreen(
      <WorkOrderListView basePath="/en/p" items={[]} errorCode={null} canWrite={false} />,
    );
    expect(screen.queryByRole('link', { name: 'New work order' })).not.toBeInTheDocument();
  });

  it('shows a translated error', () => {
    renderScreen(
      <WorkOrderListView basePath="/en/p" items={null} errorCode="FORBIDDEN" canWrite={false} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this');
  });
});
