import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractorPortalResponse } from '@ftth/shared';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { ContractorPortal } from './contractor-portal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const api = vi.hoisted(() => ({ getContractorPortal: vi.fn() }));
vi.mock('../api/portal-api', () => api);
vi.mock('@/features/auth/api/session-client', () => ({
  fetchMe: vi.fn().mockResolvedValue({ displayName: 'Ali' }),
  logout: vi.fn(),
  login: vi.fn(),
  SessionApiError: class extends Error {},
}));

const REG_1 = '4c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const REG_2 = '4d1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const LINE_1 = '6a000000-0000-4000-8000-000000000001';
const LINE_2 = '6a000000-0000-4000-8000-000000000002';
const uuid = (n: number) => `9a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const portal = (): ContractorPortalResponse => ({
  serverTime: '2026-11-21T08:00:00.000Z',
  contractor: { id: uuid(1), name: 'Nile Cables' },
  registrations: [
    {
      registrationId: REG_1,
      projectId: uuid(2),
      projectName: 'Alpha Project',
      workOrderNumber: 'WO-7',
      currency: 'EGP',
      registeredOn: '2026-10-01',
      lines: [
        {
          contractorLineId: LINE_1,
          code: 'C-001',
          description: 'Trenching',
          unit: 'm',
          scope: null,
          quantity: '1000',
          prices: [
            { effectiveFrom: '2026-10-01', unitPrice: '80' },
            { effectiveFrom: '2026-11-01', unitPrice: '90.5' },
          ],
          recordedQuantity: '30',
        },
      ],
    },
    {
      registrationId: REG_2,
      projectId: uuid(3),
      projectName: 'Beta Project',
      workOrderNumber: 'WO-9',
      currency: 'USD',
      registeredOn: '2026-10-05',
      lines: [
        {
          contractorLineId: LINE_2,
          code: 'B-002',
          description: 'Box install',
          unit: 'no',
          scope: 'Install the box',
          quantity: '10',
          prices: [{ effectiveFrom: '2026-10-05', unitPrice: '12' }],
          recordedQuantity: '1',
        },
      ],
    },
  ],
  work: [
    {
      key: 'u3:1',
      registrationId: REG_1,
      contractorLineId: LINE_1,
      element: { featureType: 'route', code: 'R-12' },
      workDate: '2026-11-18',
      quantity: '10',
      status: 'approved',
      reviewReason: null,
      unitPrice: '90.5',
      value: '905',
    },
    {
      key: 'u2:1',
      registrationId: REG_1,
      contractorLineId: LINE_1,
      element: { featureType: 'route', code: 'R-11' },
      workDate: '2026-11-10',
      quantity: '20',
      status: 'pending',
      reviewReason: null,
      unitPrice: '90.5',
      value: '1810',
    },
    {
      key: 'u1:1',
      registrationId: REG_2,
      contractorLineId: LINE_2,
      element: { featureType: 'box', code: null },
      workDate: '2026-11-02',
      quantity: '1',
      status: 'rejected',
      reviewReason: 'Wrong box type',
      unitPrice: '12',
      value: '12',
    },
  ],
  totals: [
    { currency: 'EGP', approved: '905', pending: '1810', rejected: '0' },
    { currency: 'USD', approved: '0', pending: '0', rejected: '12' },
  ],
});

describe('ContractorPortal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getContractorPortal.mockResolvedValue(portal());
  });

  it('shows the contractor, the review note and the three totals per currency', async () => {
    renderScreen(<ContractorPortal />);
    expect(await screen.findByRole('heading', { name: 'Nile Cables', level: 1 })).toBeVisible();
    expect(screen.getByText(/stays «under review»/)).toBeInTheDocument();
    const egp = screen.getByLabelText('Totals in EGP');
    expect(within(egp).getByText('Approved')).toBeInTheDocument();
    expect(within(egp).getByText('Under review')).toBeInTheDocument();
    expect(within(egp).getByText('Rejected')).toBeInTheDocument();
    expect(within(egp).getByText('905.00 EGP')).toBeInTheDocument();
    expect(within(egp).getByText('1,810.00 EGP')).toBeInTheDocument();
    expect(within(egp).getByText('0.00 EGP')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Totals in USD')).getByText('12.00 USD'),
    ).toBeInTheDocument();
  });

  it('lists his lines per registration with scope and the dated price history', async () => {
    renderScreen(<ContractorPortal />);
    const table = await screen.findByRole('table', {
      name: 'My lines in Alpha Project, work order WO-7',
    });
    const row = within(within(table).getAllByRole('row')[1] as HTMLElement);
    expect(row.getByText('C-001').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(row.getByText('Whole line')).toBeInTheDocument();
    expect(row.getByText('1,000')).toBeInTheDocument();
    expect(row.getByText('30')).toBeInTheDocument();
    expect(row.getAllByText('90.50')).toHaveLength(2); // current price and history
    expect(row.getByText('80.00')).toBeInTheDocument();
    const beta = screen.getByRole('table', { name: 'My lines in Beta Project, work order WO-9' });
    expect(within(beta).getByText('Install the box')).toBeInTheDocument();
  });

  it('lists the work newest first with status words, reason, price and value', async () => {
    renderScreen(<ContractorPortal />);
    const table = await screen.findByRole('table', { name: 'Recorded work, newest first' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    const first = within(rows[1] as HTMLElement);
    expect(first.getByText('2026-11-18')).toBeInTheDocument();
    expect(first.getByText('R-12').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(first.getByText('Approved')).toBeInTheDocument();
    expect(first.getByText('905.00 EGP')).toBeInTheDocument();
    const last = within(rows[3] as HTMLElement);
    expect(last.getByText('Rejected')).toBeInTheDocument();
    expect(last.getByText('Wrong box type')).toBeInTheDocument();
    expect(last.getByText('12.00 USD')).toBeInTheDocument();
  });

  it('filters the work by registration and by status', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractorPortal />);
    const table = await screen.findByRole('table', { name: 'Recorded work, newest first' });
    await user.selectOptions(screen.getByLabelText('Work order'), REG_1);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText('2026-11-10')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'rejected');
    expect(screen.getByText('No work recorded yet')).toBeInTheDocument();
  });

  it('renders no contract price, supervisor, photo or link, even if the server sent them', async () => {
    const data = portal();
    const leaky = {
      ...data,
      registrations: data.registrations.map((entry) => ({ ...entry, contractPrice: '777.77' })),
      work: data.work.map((entry) => ({
        ...entry,
        supervisorName: 'Sup Visor',
        photoUrl: 'https://x/photo.jpg',
      })),
    };
    api.getContractorPortal.mockResolvedValue(leaky);
    renderScreen(<ContractorPortal />);
    await screen.findByRole('heading', { name: 'Nile Cables' });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('777.77');
    expect(text).not.toContain('Sup Visor');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('is right-to-left in Arabic with left-to-right numbers', async () => {
    renderScreen(<ContractorPortal />, { locale: 'ar' });
    expect(await screen.findByText('R-12')).toBeInTheDocument();
    expect(screen.getByText('R-12').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(screen.getAllByText('مقبول').length).toBeGreaterThan(0);
  });

  it('shows a failure and no data on a 403', async () => {
    api.getContractorPortal.mockRejectedValue(new ApiClientError('FORBIDDEN', 403));
    renderScreen(<ContractorPortal />);
    expect(await screen.findByRole('alert')).toHaveTextContent('You are not allowed to do this');
    expect(screen.queryByText('Nile Cables')).not.toBeInTheDocument();
  });
});
