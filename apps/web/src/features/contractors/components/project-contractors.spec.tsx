import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PM_ACCESS, PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import {
  REGISTRATION_ID,
  SCOPE_BOX,
  projectContractors,
  scopedProject,
} from '@/test-utils/contractors';
import { ProjectContractors } from './project-contractors';

const api = vi.hoisted(() => ({ getProjectContractors: vi.fn() }));
vi.mock('../api/contractors-api', () => api);
const accounts = vi.hoisted(() => ({
  listContractorAccounts: vi.fn(),
  createContractorAccount: vi.fn(),
  setContractorAccountActive: vi.fn(),
}));
vi.mock('@/features/contractor-accounts/api/accounts-api', () => accounts);

describe('ProjectContractors (PM, read-only)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    accounts.listContractorAccounts.mockResolvedValue({
      contractorId: '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f',
      items: [],
    });
  });

  it('shows the registrations, lines and exact total without any action', async () => {
    api.getProjectContractors.mockResolvedValue(projectContractors());
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByRole('heading', { name: 'Subcontractors', level: 1 })).toBeVisible();
    expect(screen.getByText('Read-only view')).toBeInTheDocument();
    expect(screen.getByText('Nile Cables')).toBeInTheDocument();
    expect(screen.getByText('Trenching')).toBeInTheDocument();
    expect(screen.getByText(/Total for this subcontractor/)).toHaveTextContent('905.00 EGP');
    expect(
      screen.queryByRole('button', { name: /quantity|price|remove/i }),
    ).not.toBeInTheDocument();
    expect(api.getProjectContractors).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('shows scopes, the split summary and the uploaded files, still without any action', async () => {
    api.getProjectContractors.mockResolvedValue(scopedProject());
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    const table = await screen.findByRole('table', { name: 'Lines of Nile Cables' });
    expect(within(table).getByText(/Whole line/)).toBeInTheDocument();
    expect(within(table).getByText(new RegExp(SCOPE_BOX))).toBeInTheDocument();
    expect(within(table).getByText(/Split: 3 scopes/)).toBeInTheDocument();
    expect(screen.getByText('nile-cables.xlsx')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /quantity|price|remove/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Upload more/ })).not.toBeInTheDocument();
  });

  it('is laid out right-to-left in Arabic with Latin, left-to-right numbers', async () => {
    api.getProjectContractors.mockResolvedValue(projectContractors());
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, {
      access: PM_ACCESS,
      locale: 'ar',
    });
    expect(
      await screen.findByRole('heading', { name: 'المقاولين الباطن', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('C-001').closest('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it('shows the contractor login accounts to the PM, per registration', async () => {
    api.getProjectContractors.mockResolvedValue(projectContractors());
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByRole('heading', { name: 'Contractor login accounts' })).toBeVisible();
    expect(accounts.listContractorAccounts).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID);
  });

  it('says a work order is needed when the project has none', async () => {
    api.getProjectContractors.mockResolvedValue(
      projectContractors({ workOrderId: null, registrations: [], availability: [] }),
    );
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByText(/no work order yet/)).toBeInTheDocument();
  });

  it('shows a failure and never leaks the data on a 403', async () => {
    api.getProjectContractors.mockRejectedValue(new ApiClientError('FORBIDDEN', 403));
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('refuses a role without contractors:read and never calls the API', () => {
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: QC_ACCESS });
    expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this');
    expect(api.getProjectContractors).not.toHaveBeenCalled();
  });
});
