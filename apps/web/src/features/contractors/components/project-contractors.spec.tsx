import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PM_ACCESS, PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import { projectContractors } from '@/test-utils/contractors';
import { ProjectContractors } from './project-contractors';

const api = vi.hoisted(() => ({ getProjectContractors: vi.fn() }));
vi.mock('../api/contractors-api', () => api);

describe('ProjectContractors (PM, read-only)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows the registrations, lines and exact total without any action', async () => {
    api.getProjectContractors.mockResolvedValue(projectContractors());
    renderScreen(<ProjectContractors projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByRole('heading', { name: 'Subcontractors', level: 1 })).toBeVisible();
    expect(screen.getByText('Read-only view')).toBeInTheDocument();
    expect(screen.getByText('Nile Cables')).toBeInTheDocument();
    expect(screen.getByText('Trenching')).toBeInTheDocument();
    expect(screen.getByText(/Total for this subcontractor/)).toHaveTextContent('905.00 EGP');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(api.getProjectContractors).toHaveBeenCalledWith(PROJECT_ID);
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
