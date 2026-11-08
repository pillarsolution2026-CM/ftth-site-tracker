import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishReadiness } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { DesignRevisionDetailScreen } from './design-revision-detail';

const api = vi.hoisted(() => ({
  getDesignRevision: vi.fn(),
  getPublishReadiness: vi.fn(),
  publishDesignRevision: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);
vi.mock('../hooks/use-text-review', () => ({ useTextReview: () => ({}) }));
vi.mock('../hooks/use-diff-view', () => ({ useDiffView: () => ({}) }));
vi.mock('./text-review', () => ({ TextReviewView: () => null }));
vi.mock('./diff-section', () => ({ DiffSection: () => null }));
vi.mock('./problems-section', () => ({ ProblemsSection: () => null }));
vi.mock('./revision-summary', () => ({ RevisionSummary: () => null }));

const CAD_FILE = '33333333-3333-4333-8333-333333333333';
const revision = {
  id: '22222222-2222-4222-8222-222222222222',
  cadFileId: CAD_FILE,
  revNo: null,
  status: 'draft',
};

function readiness(overrides: Partial<PublishReadiness> = {}): PublishReadiness {
  return {
    checks: [
      { key: 'crs_known', ok: true, count: null },
      { key: 'control_point', ok: true, count: 1 },
      { key: 'no_problems', ok: true, count: 0 },
      { key: 'open_items', ok: true, count: 0 },
    ],
    canPublish: true,
    needsAcknowledgement: false,
    ...overrides,
  };
}

function renderDetail() {
  renderScreen(
    <DesignRevisionDetailScreen
      projectId="p"
      revisionId={revision.id}
      listPath="/en/projects/p/design-revisions"
      cadFilesPath="/en/projects/p/cad-files"
    />,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getDesignRevision.mockResolvedValue(revision);
});

describe('DesignRevisionDetailScreen publish checklist', () => {
  it('publishes without acknowledgement when everything is ok', async () => {
    const user = userEvent.setup();
    api.getPublishReadiness.mockResolvedValue(readiness());
    api.publishDesignRevision.mockResolvedValue(revision);
    renderDetail();
    const button = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(api.publishDesignRevision).toHaveBeenCalledWith('p', revision.id, {
      acknowledgeOpenItems: false,
    });
  });

  it('requires the acknowledgement for open items, then sends it', async () => {
    const user = userEvent.setup();
    api.getPublishReadiness.mockResolvedValue(
      readiness({
        needsAcknowledgement: true,
        checks: readiness().checks.map((c) =>
          c.key === 'open_items' ? { ...c, ok: false, count: 3 } : c,
        ),
      }),
    );
    api.publishDesignRevision.mockResolvedValue(revision);
    renderDetail();
    const button = await screen.findByRole('button', { name: 'Publish' });
    const box = await screen.findByLabelText(/I understand/);
    expect(button).toBeDisabled();
    await user.click(box);
    expect(button).toBeEnabled();
    await user.click(button);
    expect(api.publishDesignRevision).toHaveBeenCalledWith('p', revision.id, {
      acknowledgeOpenItems: true,
    });
  });

  it('locks Publish on a failing check and links to the mapping screen', async () => {
    api.getPublishReadiness.mockResolvedValue(
      readiness({
        canPublish: false,
        checks: readiness().checks.map((c) => (c.key === 'crs_known' ? { ...c, ok: false } : c)),
      }),
    );
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Open the coordinates screen' });
    expect(link).toHaveAttribute('href', `/en/projects/p/cad-files/${CAD_FILE}/mapping`);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('shows the refusal reason of a 409 and refetches the checklist', async () => {
    const user = userEvent.setup();
    api.getPublishReadiness.mockResolvedValue(readiness());
    api.publishDesignRevision.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'PROBLEMS_OPEN', problemCount: 4 }),
    );
    renderDetail();
    const button = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/4.* drawing errors are left/)).toBeInTheDocument();
    await waitFor(() => expect(api.getPublishReadiness).toHaveBeenCalledTimes(2));
  });
});
