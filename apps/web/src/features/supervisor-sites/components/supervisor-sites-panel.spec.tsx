import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { SupervisorSitesPanel } from './supervisor-sites-panel';

const api = vi.hoisted(() => ({ getSupervisorSites: vi.fn(), replaceSupervisorSites: vi.fn() }));
vi.mock('../api/supervisor-sites-api', () => api);

const WO_1 = '2b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const WO_2 = '2b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e2f';
const S1 = '5a000000-0000-4000-8000-000000000001';
const S2 = '5a000000-0000-4000-8000-000000000002';
const S3 = '5a000000-0000-4000-8000-000000000003';
const U1 = '7a000000-0000-4000-8000-000000000001';
const U2 = '7a000000-0000-4000-8000-000000000002';

const data = () => ({
  sites: [
    { siteId: S1, name: 'Site A', workOrderId: WO_1, workOrderNumber: 'WO-1' },
    { siteId: S2, name: 'Site B', workOrderId: WO_1, workOrderNumber: 'WO-1' },
    { siteId: S3, name: 'Site C', workOrderId: WO_2, workOrderNumber: 'WO-2' },
  ],
  supervisors: [
    { userId: U1, displayName: 'Omar', email: 'omar@example.com', isActive: true, siteIds: [S1] },
    { userId: U2, displayName: 'Sara', email: 'sara@example.com', isActive: true, siteIds: [] },
  ],
});

const card = (name: string) => screen.findByRole('form', { name });

describe('SupervisorSitesPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getSupervisorSites.mockResolvedValue(data());
    api.replaceSupervisorSites.mockResolvedValue(data().supervisors[0]);
  });

  it('loads the supervisors with their sites grouped by work order and the note', async () => {
    renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    const omar = await card('Omar');
    expect(within(omar).getByLabelText('Site A')).toBeChecked();
    expect(within(omar).getByLabelText('Site B')).not.toBeChecked();
    expect(within(omar).getAllByRole('group')).toHaveLength(2);
    expect(within(await card('Sara')).getByLabelText('Site A')).not.toBeChecked();
    expect(screen.getByText(/sees and records only on his own sites/)).toBeInTheDocument();
    expect(api.getSupervisorSites).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('keeps Save off until a site is toggled, then saves his site ids and shows the saved state', async () => {
    const user = userEvent.setup();
    renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    const omar = await card('Omar');
    const save = within(omar).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(within(omar).getByLabelText('Site C'));
    await user.click(within(omar).getByLabelText('Site A'));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(api.replaceSupervisorSites).toHaveBeenCalledWith(PROJECT_ID, U1, { siteIds: [S3] }),
    );
    expect(await within(omar).findByText(/sites are saved/)).toBeInTheDocument();
  });

  it('can empty a supervisor (no site)', async () => {
    const user = userEvent.setup();
    renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    const omar = await card('Omar');
    await user.click(within(omar).getByLabelText('Site A'));
    await user.click(within(omar).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.replaceSupervisorSites).toHaveBeenCalledWith(PROJECT_ID, U1, { siteIds: [] }),
    );
  });

  it('translates a 404 (not a supervisor) and a 422 (foreign site)', async () => {
    const user = userEvent.setup();
    renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    const omar = await card('Omar');
    const sara = await card('Sara');
    api.replaceSupervisorSites.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 404));
    await user.click(within(omar).getByLabelText('Site B'));
    await user.click(within(omar).getByRole('button', { name: 'Save' }));
    expect(
      await within(omar).findByText('This user is not a supervisor of this project'),
    ).toBeInTheDocument();
    api.replaceSupervisorSites.mockRejectedValueOnce(new ApiClientError('VALIDATION_FAILED', 422));
    await user.click(within(sara).getByLabelText('Site B'));
    await user.click(within(sara).getByRole('button', { name: 'Save' }));
    expect(await within(sara).findByText(/not a site of this project/)).toBeInTheDocument();
    // The draft stays so he can retry.
    expect(within(sara).getByLabelText('Site B')).toBeChecked();
  });

  it('shows a load error and the empty states', async () => {
    api.getSupervisorSites.mockRejectedValueOnce(new ApiClientError('FORBIDDEN', 403));
    const first = renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    first.unmount();
    api.getSupervisorSites.mockResolvedValueOnce({ sites: [], supervisors: data().supervisors });
    renderScreen(<SupervisorSitesPanel projectId={PROJECT_ID} />);
    expect(await screen.findByText(/have no sites yet/)).toBeInTheDocument();
  });
});
