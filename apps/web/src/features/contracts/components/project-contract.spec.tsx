import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PM_ACCESS, PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import { contractDetail } from '@/test-utils/contract';
import { ProjectContract } from './project-contract';

const api = vi.hoisted(() => ({ getProjectContract: vi.fn() }));
vi.mock('../api/contracts-api', () => api);

describe('ProjectContract (PM, read-only)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows the contract and its BOQ without any edit action', async () => {
    api.getProjectContract.mockResolvedValue(contractDetail({ status: 'approved' }));
    renderScreen(<ProjectContract projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByRole('heading', { name: 'Contract' })).toBeInTheDocument();
    expect(screen.getByText('Read-only view')).toBeInTheDocument();
    expect(screen.getByText('Civil works')).toBeInTheDocument();
    expect(screen.getByText('C-2026-01')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import from Excel' })).not.toBeInTheDocument();
    expect(api.getProjectContract).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('says so when the project has no contract (404)', async () => {
    api.getProjectContract.mockRejectedValue(new ApiClientError('NOT_FOUND', 404));
    renderScreen(<ProjectContract projectId={PROJECT_ID} />, { access: PM_ACCESS });
    expect(await screen.findByText('This project has no contract')).toBeInTheDocument();
  });

  it('refuses a role without contract:read and never calls the API', () => {
    renderScreen(<ProjectContract projectId={PROJECT_ID} />, { access: QC_ACCESS });
    expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this');
    expect(api.getProjectContract).not.toHaveBeenCalled();
  });
});
