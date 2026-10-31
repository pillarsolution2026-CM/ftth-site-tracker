import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractSummary } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { CONTRACT_ID } from '@/test-utils/contract';
import { ContractsAdmin } from './contracts-admin';

const api = vi.hoisted(() => ({
  listContracts: vi.fn(),
  createContract: vi.fn(),
}));
vi.mock('../api/contracts-api', () => api);
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const ISO = '2026-10-31T08:00:00.000Z';
const summary = (overrides: Partial<ContractSummary> = {}): ContractSummary => ({
  id: CONTRACT_ID,
  number: 'C-1',
  name: 'FTTH Cairo',
  client: 'Telecom Co',
  currency: 'EGP',
  startsOn: null,
  durationDays: null,
  status: 'draft',
  approvedAt: null,
  itemCount: 160,
  total: '236701830.984',
  projectCount: 2,
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

describe('ContractsAdmin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listContracts.mockResolvedValue({
      items: [
        summary(),
        summary({
          id: '5a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f',
          number: 'C-2',
          status: 'approved',
          itemCount: 3,
          total: '10',
          projectCount: 0,
        }),
      ],
    });
  });

  it('lists number, name, client, currency, status, items, total with currency and projects', async () => {
    renderScreen(<ContractsAdmin />);
    const table = await screen.findByRole('table', { name: 'All contracts' });
    const rows = within(table).getAllByRole('row');
    const first = within(rows[1] as HTMLElement);
    expect(first.getByText('C-1').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(first.getByText('FTTH Cairo')).toBeInTheDocument();
    expect(first.getByText('Telecom Co')).toBeInTheDocument();
    expect(first.getByText('Draft')).toBeInTheDocument(); // status by text, not colour alone
    expect(first.getByText('160')).toBeInTheDocument();
    expect(first.getByText('236,701,830.984 EGP')).toBeInTheDocument();
    expect(first.getByText('2')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Approved')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Open contract C-1' })).toHaveAttribute(
      'href',
      `/en/admin/contracts/${CONTRACT_ID}`,
    );
  });

  it('validates the create form: required fields and an ISO currency', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractsAdmin />);
    await screen.findByRole('table', { name: 'All contracts' });
    await user.type(screen.getByLabelText('Currency'), 'e');
    await user.click(screen.getByRole('button', { name: 'Create contract' }));
    expect(screen.getAllByText('This field is required').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Three capital letters, e.g. EGP')).toBeInTheDocument();
    expect(api.createContract).not.toHaveBeenCalled();
  });

  it('creates an empty draft and opens it; the currency hint says it cannot change later', async () => {
    api.createContract.mockResolvedValue({ ...summary(), items: [], attachments: [] });
    const user = userEvent.setup();
    renderScreen(<ContractsAdmin />);
    await screen.findByRole('table', { name: 'All contracts' });
    expect(screen.getByText('ISO code, e.g. EGP. Cannot be changed later.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Contract number'), 'C-9');
    await user.type(screen.getByLabelText('Contract name'), 'New');
    await user.type(screen.getByLabelText('Client'), 'Client X');
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.type(screen.getByLabelText('Contract duration (days)'), '90');
    await user.click(screen.getByRole('button', { name: 'Create contract' }));

    await vi.waitFor(() => expect(api.createContract).toHaveBeenCalledTimes(1));
    expect(api.createContract.mock.calls[0]?.[0]).toEqual({
      number: 'C-9',
      name: 'New',
      client: 'Client X',
      currency: 'USD',
      startsOn: null,
      durationDays: 90,
      notes: null,
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(`/en/admin/contracts/${CONTRACT_ID}`));
  });

  it('shows the duplicate-number conflict', async () => {
    api.createContract.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'DUPLICATE_NUMBER' }),
    );
    const user = userEvent.setup();
    renderScreen(<ContractsAdmin />);
    await screen.findByRole('table', { name: 'All contracts' });
    await user.type(screen.getByLabelText('Contract number'), 'C-1');
    await user.type(screen.getByLabelText('Contract name'), 'N');
    await user.type(screen.getByLabelText('Client'), 'C');
    await user.type(screen.getByLabelText('Currency'), 'EGP');
    await user.click(screen.getByRole('button', { name: 'Create contract' }));
    expect(await screen.findByText('This contract number is already used')).toBeInTheDocument();
  });
});
