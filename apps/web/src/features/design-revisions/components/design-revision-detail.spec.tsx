import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishReadiness } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { QC_ACCESS, renderScreen } from '@/test-utils/render';
import type { ProjectAccess } from '@/features/projects/model/project-access';
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
const sections = vi.hoisted(() => ({
  problems: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  corrections: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  viewer: vi.fn<(props: Record<string, unknown>) => null>(() => null),
}));
vi.mock('./drawing-viewer', () => ({ DrawingViewer: sections.viewer }));
vi.mock('./problems-section', () => ({ ProblemsSection: sections.problems }));
vi.mock('./corrections-panel', () => ({ CorrectionsSection: sections.corrections }));
vi.mock('./revision-summary', () => ({ RevisionSummary: () => null }));

const CAD_FILE = '33333333-3333-4333-8333-333333333333';
const revision = {
  id: '22222222-2222-4222-8222-222222222222',
  cadFileId: CAD_FILE,
  drawingKind: 'general',
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
      { key: 'other_drawing', ok: true, count: 0 },
    ],
    canPublish: true,
    drawingKind: 'general',
    otherRevisionId: null,
    needsAcknowledgement: false,
    ...overrides,
  };
}

function renderDetail(access?: ProjectAccess) {
  renderScreen(
    <DesignRevisionDetailScreen
      projectId="p"
      revisionId={revision.id}
      listPath="/en/projects/p/design-revisions"
      cadFilesPath="/en/projects/p/cad-files"
    />,
    access ? { access } : {},
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getDesignRevision.mockResolvedValue(revision);
  sections.problems.mockClear();
  sections.corrections.mockClear();
  sections.viewer.mockClear();
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
      new ApiClientError('CONFLICT', 409, {
        reason: 'PROBLEMS_OPEN',
        drawingKind: 'secondary',
        problemCount: 4,
      }),
    );
    renderDetail();
    const button = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(
      await screen.findByText(/4.* drawing errors are left in the Secondary drawing/),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.getPublishReadiness).toHaveBeenCalledTimes(2));
  });
});

describe('DesignRevisionDetailScreen pair publishing', () => {
  it('explains the other drawing and links to its draft', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    api.getPublishReadiness.mockResolvedValue(
      readiness({
        checks: [
          { key: 'crs_known', ok: true, count: null },
          { key: 'control_point', ok: true, count: 1 },
          { key: 'no_problems', ok: true, count: 0 },
          { key: 'open_items', ok: true, count: 0 },
          { key: 'other_drawing', ok: false, count: 3 },
        ],
        canPublish: false,
        otherRevisionId: other,
      }),
    );
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Open the Secondary draft' });
    expect(link).toHaveAttribute('href', `/en/projects/p/design-revisions/${other}`);
    expect(screen.getByText(/3.* errors in it/)).toBeInTheDocument();
  });
});

describe('DesignRevisionDetailScreen drawing corrections', () => {
  const lastProps = (fn: typeof sections.problems) =>
    (fn.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

  it('offers the fix tools and the rebuild on a draft to a user who can write designs', async () => {
    api.getPublishReadiness.mockResolvedValue(readiness());
    renderDetail();
    await screen.findByRole('button', { name: 'Publish' });
    expect(lastProps(sections.problems)).toMatchObject({ canFix: true, cadFileId: CAD_FILE });
    expect(lastProps(sections.corrections)).toMatchObject({
      canEdit: true,
      cadFileId: CAD_FILE,
      listPath: '/en/projects/p/design-revisions',
    });
  });

  it('offers neither on a published revision', async () => {
    api.getDesignRevision.mockResolvedValue({ ...revision, status: 'published', revNo: 2 });
    renderDetail();
    await waitFor(() => expect(sections.corrections).toHaveBeenCalled());
    expect(lastProps(sections.problems)).toMatchObject({ canFix: false });
    expect(lastProps(sections.corrections)).toMatchObject({ canEdit: false });
  });

  it('offers neither without design:write', async () => {
    renderDetail(QC_ACCESS);
    await waitFor(() => expect(sections.corrections).toHaveBeenCalled());
    expect(lastProps(sections.problems)).toMatchObject({ canFix: false });
    expect(lastProps(sections.corrections)).toMatchObject({ canEdit: false });
  });
});

describe('DesignRevisionDetailScreen drawing viewer', () => {
  const lastProps = (fn: typeof sections.viewer) =>
    (fn.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];

  it('shows the viewer for the revision file and lets the fix tools in only on a draft', async () => {
    api.getPublishReadiness.mockResolvedValue(readiness());
    renderDetail();
    await waitFor(() => expect(sections.viewer).toHaveBeenCalled());
    expect(lastProps(sections.viewer)).toMatchObject({
      cadFileId: CAD_FILE,
      canWrite: true,
      canFix: true,
      focus: null,
    });
  });

  it('sends a «show on the drawing» request from the problems table to the viewer', async () => {
    api.getPublishReadiness.mockResolvedValue(readiness());
    renderDetail();
    await waitFor(() => expect(sections.problems).toHaveBeenCalled());
    const show = lastProps(sections.problems).onShowOnDrawing as (place: unknown) => void;
    act(() => show({ code: 'WRONG_LAYER', handle: 'A1', x: 1, y: 2 }));
    expect(lastProps(sections.viewer).focus).toEqual({
      code: 'WRONG_LAYER',
      handle: 'A1',
      x: 1,
      y: 2,
      nonce: 1,
    });
    act(() => show({ code: 'WRONG_LAYER', handle: 'A1', x: 1, y: 2 }));
    expect(lastProps(sections.viewer).focus).toMatchObject({ nonce: 2 });
  });

  it('does not show the viewer before the revision is built', async () => {
    api.getDesignRevision.mockResolvedValue({ ...revision, status: 'queued' });
    renderDetail();
    await screen.findByText(/once the build has finished/);
    expect(sections.viewer).not.toHaveBeenCalled();
  });
});
