import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GpsProposal } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { useGpsProposalsPanel } from '../hooks/use-gps-proposals';
import { GpsProposalsPanel } from './gps-proposals-panel';

const api = vi.hoisted(() => ({
  listGpsProposals: vi.fn(),
  acceptGpsProposal: vi.fn(),
  rejectGpsProposal: vi.fn(),
  gpsProposalPhotoUrl: (projectId: string, id: string) =>
    `/api/projects/${projectId}/gps-proposals/${id}/photo`,
}));
vi.mock('../api/proposals-api', () => api);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CAD_FILE = '22222222-2222-4222-8222-222222222222';
const ID_A = '33333333-3333-4333-8333-333333333333';
const ID_B = '44444444-4444-4444-8444-444444444444';
const USER = { id: '55555555-5555-4555-8555-555555555555', name: 'Ahmed Samir' };

function proposal(overrides: Partial<GpsProposal> = {}): GpsProposal {
  return {
    id: ID_A,
    designRevisionId: '66666666-6666-4666-8666-666666666666',
    revNo: 2,
    cadFileId: CAD_FILE,
    featureId: '77777777-7777-4777-8777-777777777777',
    featureType: 'cabinet',
    code: '1-7',
    handle: 'C1',
    lat: 30.9845069,
    lon: 32.7832491,
    accuracyM: 3.2,
    fixAt: '2026-11-08T09:00:00.000Z',
    receivedAt: '2026-11-08T09:01:00.000Z',
    proposedBy: USER,
    note: 'At the gate',
    photo: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    rejectReason: null,
    acceptedMappingVersion: null,
    ...overrides,
  };
}

const onReload = vi.fn();

function Harness({ mappingVersion = 4 }: { mappingVersion?: number | null }) {
  const panel = useGpsProposalsPanel({
    projectId: PROJECT,
    cadFileId: CAD_FILE,
    enabled: true,
    mappingVersion,
    onReload,
  });
  return (
    <GpsProposalsPanel
      {...panel}
      photoUrl={(id) => api.gpsProposalPhotoUrl(PROJECT, id)}
      onToggleHistory={panel.toggleHistory}
      onAccept={(id) => void panel.accept(id)}
      onReject={panel.reject}
      onReload={() => void panel.reload()}
    />
  );
}

beforeEach(() => {
  api.listGpsProposals.mockReset();
  api.acceptGpsProposal.mockReset();
  api.rejectGpsProposal.mockReset();
  onReload.mockReset();
  api.listGpsProposals.mockResolvedValue({ items: [proposal()] });
});

describe('GpsProposalsPanel', () => {
  it('lists a pending proposal with its details, LTR numbers and the accuracy in metres', async () => {
    renderScreen(<Harness />);
    const card = await screen.findByRole('article', { name: /Cabinet 1-7/ });
    expect(within(card).getByText('Ahmed Samir')).toBeInTheDocument();
    expect(within(card).getByText(/±.*3\.2.* m/)).toBeInTheDocument();
    expect(within(card).getByText('30.9845069, 32.7832491')).toBeInTheDocument();
    expect(within(card).getByText('At the gate')).toBeInTheDocument();
    expect(api.listGpsProposals).toHaveBeenCalledWith(PROJECT, {
      cadFileId: CAD_FILE,
      status: 'pending',
    });
  });

  it('falls back to the drawing handle when the item has no code', async () => {
    api.listGpsProposals.mockResolvedValue({ items: [proposal({ code: null })] });
    renderScreen(<Harness />);
    expect(await screen.findByRole('article', { name: /Cabinet #C1/ })).toBeInTheDocument();
  });

  it('shows the photo only when it is stored, and enlarges it on click', async () => {
    const user = userEvent.setup();
    api.listGpsProposals.mockResolvedValue({
      items: [
        proposal({ photo: { id: ID_B, stored: true } }),
        proposal({
          id: ID_B,
          code: '2-1',
          photo: { id: '88888888-8888-4888-8888-888888888888', stored: false },
        }),
      ],
    });
    renderScreen(<Harness />);
    const stored = await screen.findByRole('article', { name: /Cabinet 1-7/ });
    const uploading = screen.getByRole('article', { name: /Cabinet 2-1/ });

    const image = within(stored).getByRole('img', { name: 'Point photo' });
    expect(image).toHaveAttribute('src', `/api/projects/${PROJECT}/gps-proposals/${ID_A}/photo`);
    expect(within(uploading).queryByRole('img')).not.toBeInTheDocument();
    expect(within(uploading).getByText('Photo is still uploading')).toBeInTheDocument();

    const open = within(stored).getByRole('button', { name: /Enlarge photo/ });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    await user.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows no photo for a proposal without one', async () => {
    renderScreen(<Harness />);
    const card = await screen.findByRole('article', { name: /Cabinet 1-7/ });
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();
  });

  it('accepts with the loaded mapping version, reloads and says it does not build', async () => {
    const user = userEvent.setup();
    api.acceptGpsProposal.mockResolvedValue(proposal({ status: 'accepted' }));
    renderScreen(<Harness mappingVersion={4} />);
    await user.click(await screen.findByRole('button', { name: /Accept point Cabinet 1-7/ }));
    expect(api.acceptGpsProposal).toHaveBeenCalledWith(PROJECT, ID_A, 4);
    expect(await screen.findByText(/The point was added.*Build revision/)).toBeInTheDocument();
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('cannot accept before a mapping is saved', async () => {
    renderScreen(<Harness mappingVersion={null} />);
    expect(await screen.findByRole('button', { name: /Accept point/ })).toBeDisabled();
    expect(screen.getByText(/Save the mapping first/)).toBeInTheDocument();
  });

  it('requires a reason to reject, then sends it trimmed', async () => {
    const user = userEvent.setup();
    api.rejectGpsProposal.mockResolvedValue(
      proposal({ status: 'rejected', rejectReason: 'Wrong cabinet' }),
    );
    renderScreen(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Reject point Cabinet 1-7/ }));

    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(screen.getByText('Write the reason for rejecting')).toBeInTheDocument();
    expect(api.rejectGpsProposal).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Reason for rejecting'), '  Wrong cabinet ');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(api.rejectGpsProposal).toHaveBeenCalledWith(PROJECT, ID_A, 'Wrong cabinet');
    expect(await screen.findByText('The point was rejected.')).toBeInTheDocument();
  });

  it('caps the reason at 500 characters', async () => {
    const user = userEvent.setup();
    renderScreen(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Reject point/ }));
    expect(screen.getByLabelText('Reason for rejecting')).toHaveAttribute('maxlength', '500');
  });

  it('offers a reload on VERSION_MISMATCH and does not reload by itself', async () => {
    const user = userEvent.setup();
    api.acceptGpsProposal.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'VERSION_MISMATCH' }),
    );
    renderScreen(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Accept point/ }));
    expect(await screen.findByText(/The mapping changed since you opened it/)).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('refreshes the list on ALREADY_DECIDED', async () => {
    const user = userEvent.setup();
    api.acceptGpsProposal.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'ALREADY_DECIDED' }),
    );
    renderScreen(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Accept point/ }));
    expect(await screen.findByText(/already decided.*refreshed/)).toBeInTheDocument();
    await waitFor(() => expect(api.listGpsProposals.mock.calls.length).toBeGreaterThan(1));
  });

  it('explains TOO_MANY_POINTS', async () => {
    const user = userEvent.setup();
    api.acceptGpsProposal.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'TOO_MANY_POINTS' }),
    );
    renderScreen(<Harness />);
    await user.click(await screen.findByRole('button', { name: /Accept point/ }));
    expect(await screen.findByText(/maximum number of control points/)).toBeInTheDocument();
  });

  it('shows accepted and rejected history with decider, time and reason on demand', async () => {
    const user = userEvent.setup();
    api.listGpsProposals.mockImplementation((_project: string, query: { status?: string }) =>
      Promise.resolve({
        items:
          query.status === 'pending'
            ? []
            : [
                proposal({
                  status: 'rejected',
                  decidedBy: { id: USER.id, name: 'Mona PM' },
                  decidedAt: '2026-11-08T10:00:00.000Z',
                  rejectReason: 'Wrong cabinet',
                }),
                proposal({
                  id: ID_B,
                  code: '2-1',
                  status: 'accepted',
                  decidedBy: { id: USER.id, name: 'Mona PM' },
                  decidedAt: '2026-11-08T11:00:00.000Z',
                  acceptedMappingVersion: 5,
                }),
              ],
      }),
    );
    renderScreen(<Harness />);
    expect(
      await screen.findByText('No GPS points are waiting for a decision.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show history' }));

    const rejected = await screen.findByRole('article', { name: /Cabinet 1-7/ });
    expect(within(rejected).getByText('Rejected')).toBeInTheDocument();
    expect(within(rejected).getByText(/by Mona PM/)).toBeInTheDocument();
    expect(within(rejected).getByText(/Reason: Wrong cabinet/)).toBeInTheDocument();
    expect(
      within(rejected).queryByRole('button', { name: /Accept|Reject/ }),
    ).not.toBeInTheDocument();
    const accepted = screen.getByRole('article', { name: /Cabinet 2-1/ });
    expect(within(accepted).getByText('Accepted')).toBeInTheDocument();
    expect(within(accepted).getByText('Mapping version 5')).toBeInTheDocument();
  });
});
