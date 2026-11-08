import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingCorrection } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { CorrectionsSection } from './corrections-panel';

const api = vi.hoisted(() => ({
  listCorrections: vi.fn(),
  withdrawCorrection: vi.fn(),
  rebuildDesignRevision: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);
const mappingApi = vi.hoisted(() => ({ getMapping: vi.fn() }));
vi.mock('@/features/cad-mapping/api/mapping-api', () => mappingApi);
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';
const NEW_REVISION = '66666666-6666-4666-8666-666666666666';
const FILE = '33333333-3333-4333-8333-333333333333';
const USER = { id: '44444444-4444-4444-8444-444444444444', name: 'Mona' };
const BUILT_AT = '2026-11-09T09:00:00.000Z';

function item(id: string, overrides: Partial<DrawingCorrection> = {}): DrawingCorrection {
  return {
    id,
    cadFileId: FILE,
    correction: { kind: 'move_layer', handle: 'A1', toLayer: 'JOINT' },
    problem: { code: 'WRONG_LAYER', handle: 'A1' },
    createdBy: USER,
    createdAt: '2026-11-09T10:00:00.000Z',
    withdrawnBy: null,
    withdrawnAt: null,
    ...overrides,
  };
}

const ACTIVE = '55555555-5555-4555-8555-555555555551';
const OLD = '55555555-5555-4555-8555-555555555552';

function renderPanel(canEdit = true) {
  renderScreen(
    <CorrectionsSection
      projectId={PROJECT}
      revisionId={REVISION}
      cadFileId={FILE}
      builtAt={BUILT_AT}
      listPath="/en/projects/p/design-revisions"
      enabled
      canEdit={canEdit}
    />,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  push.mockReset();
  api.listCorrections.mockResolvedValue({
    items: [
      item(ACTIVE, {
        correction: { kind: 'merge_routes', handles: ['B1', 'B2'] },
        problem: { code: 'ROUTE_SPLIT', handle: 'B1/B2' },
      }),
      item(OLD, {
        createdAt: '2026-11-08T10:00:00.000Z',
        withdrawnAt: '2026-11-08T12:00:00.000Z',
        withdrawnBy: USER,
      }),
    ],
    activeCount: 1,
  });
  mappingApi.getMapping.mockResolvedValue({ cadFileId: FILE, layers: [], mapping: { version: 7 } });
});

describe('CorrectionsSection', () => {
  it('lists corrections with the kind in words, values, who and the state in text', async () => {
    renderPanel();
    expect(
      await screen.findByRole('heading', { name: /Corrections: .*1.* in force/ }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + 2; newest first as the server sends them.
    expect(rows).toHaveLength(3);
    const [, first, second] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(first).getByText('Merge routes')).toBeInTheDocument();
    expect(within(first).getByText('B1 / B2')).toBeInTheDocument();
    expect(within(first).getByText(/In force/)).toBeInTheDocument();
    expect(within(second).getByText('Move to a layer')).toBeInTheDocument();
    expect(within(second).getByText(/Withdrawn/)).toBeInTheDocument();
    expect(within(second).getAllByText(/Mona/).length).toBeGreaterThan(0);
    // Only the active one can be withdrawn.
    expect(screen.getAllByRole('button', { name: 'Withdraw the correction' })).toHaveLength(1);
  });

  it('withdraws after a confirmation', async () => {
    const user = userEvent.setup();
    api.withdrawCorrection.mockResolvedValue(item(ACTIVE));
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Withdraw the correction' }));
    const dialog = screen.getByRole('alertdialog');
    expect(api.withdrawCorrection).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(api.withdrawCorrection).toHaveBeenCalledWith(PROJECT, FILE, ACTIVE);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('cancelling the confirmation withdraws nothing', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Withdraw the correction' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(api.withdrawCorrection).not.toHaveBeenCalled();
  });

  it('says so when the correction was already withdrawn', async () => {
    const user = userEvent.setup();
    api.withdrawCorrection.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'ALREADY_WITHDRAWN' }),
    );
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Withdraw the correction' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Withdraw' }),
    );
    expect(await screen.findByText('This correction was already withdrawn')).toBeInTheDocument();
  });

  it('rebuilds with the mapping version of the file and opens the new revision', async () => {
    const user = userEvent.setup();
    api.rebuildDesignRevision.mockResolvedValue({ id: NEW_REVISION });
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Apply the corrections and rebuild' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.getByText(/Corrections made or withdrawn since this revision was built: .*1/),
    ).toBeInTheDocument();
    await user.click(button);
    expect(api.rebuildDesignRevision).toHaveBeenCalledWith(PROJECT, REVISION, {
      mappingVersion: 7,
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/en/projects/p/design-revisions/${NEW_REVISION}`),
    );
  });

  it('stays enabled with a note when nothing changed since the build', async () => {
    api.listCorrections.mockResolvedValue({ items: [], activeCount: 0 });
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Apply the corrections and rebuild' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.getByText(/No correction changed since this revision was built/),
    ).toBeInTheDocument();
  });

  it('on a mapping version conflict reloads the mapping, shows why and does not navigate', async () => {
    const user = userEvent.setup();
    api.rebuildDesignRevision.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'VERSION_MISMATCH' }),
    );
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Apply the corrections and rebuild' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/The mapping changed meanwhile/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(mappingApi.getMapping).toHaveBeenCalledTimes(2));
  });

  it('shows another 409 (not a draft) with its own message', async () => {
    const user = userEvent.setup();
    api.rebuildDesignRevision.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'NOT_DRAFT' }),
    );
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Apply the corrections and rebuild' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText('Only a draft revision can be changed')).toBeInTheDocument();
  });

  it('disables the rebuild until the file has a saved mapping', async () => {
    mappingApi.getMapping.mockResolvedValue({ cadFileId: FILE, layers: [], mapping: null });
    renderPanel();
    expect(await screen.findByText(/Save the mapping of the file first/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Apply the corrections and rebuild' }),
    ).toBeDisabled();
  });

  it('read-only (not a draft or no design:write): the list shows, no withdraw or rebuild', async () => {
    renderPanel(false);
    await screen.findByRole('table');
    expect(
      screen.queryByRole('button', { name: 'Withdraw the correction' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebuild/i })).not.toBeInTheDocument();
    expect(mappingApi.getMapping).not.toHaveBeenCalled();
  });
});
