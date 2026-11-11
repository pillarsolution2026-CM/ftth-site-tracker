import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstallationState, TrenchMark } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { useTrenchTool } from '../hooks/use-trench-tool';
import { TrenchForm } from './trench-form';
import { TrenchMarksPanel } from './trench-marks-panel';

const api = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  setInstallationAnswer: vi.fn(),
  createTrenchMark: vi.fn(),
  withdrawTrenchMark: vi.fn(),
}));
vi.mock('../api/installation-api', () => api);

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FILE = '33333333-3333-4333-8333-333333333333';
const ANSWER_ID = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555551';
const M2 = '55555555-5555-4555-8555-555555555552';

function mark(id: string, routeHandle: string, lengthM: string, withdrawn = false): TrenchMark {
  return {
    id,
    cadFileId: FILE,
    routeHandle,
    lengthM,
    createdBy: { id: ANSWER_ID, name: 'Mona' },
    createdAt: '2026-11-12T10:00:00.000Z',
    withdrawnBy: withdrawn ? { id: ANSWER_ID, name: 'Omar' } : null,
    withdrawnAt: withdrawn ? '2026-11-12T11:00:00.000Z' : null,
  };
}

function live(marks: TrenchMark[], answer: 'pull_only' | 'has_trench' = 'has_trench') {
  const state: InstallationState = {
    cadFileId: FILE,
    drawingKind: 'general',
    asked: true,
    answer: {
      id: ANSWER_ID,
      cadFileId: FILE,
      answer,
      answeredBy: null,
      answeredAt: '2026-11-12T10:00:00.000Z',
    },
    answerHistory: [],
    marks,
    activeMarkCount: marks.filter((m) => m.withdrawnAt === null).length,
    activeTrenchM: '0.000',
  };
  return state;
}

function Harness({ canEdit = true, onShow }: { canEdit?: boolean; onShow?: (h: string) => void }) {
  const tool = useTrenchTool({ projectId: PROJECT, cadFileId: FILE, enabled: true, canEdit });
  return (
    <>
      <TrenchMarksPanel tool={tool} onShow={onShow} />
      {tool.mode ? <TrenchForm tool={tool} routeHandle="A1F" /> : null}
      <output data-testid="visible">{String(tool.visible)}</output>
    </>
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('trench marks list and the «New trench» tool (ADR-042)', () => {
  it('lists marks in force and withdrawn ones, with who and the total of those in force', async () => {
    api.getInstallation.mockResolvedValue(
      live([mark(M1, 'A1F', '10.250'), mark(M2, 'B2', '4.000', true)]),
    );
    renderScreen(<Harness />);
    expect(await screen.findByText('Trench marks (⁦1⁩)')).toBeInTheDocument();
    expect(screen.getByText(/Total marked trench: .*10\.250.* m/)).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('In force')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Withdrawn')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText(/Omar/)).toBeInTheDocument();
    // Only a mark in force can be withdrawn.
    expect(screen.getAllByRole('button', { name: /Withdraw the trench mark/ })).toHaveLength(1);
  });

  it('withdraws a mark', async () => {
    api.getInstallation.mockResolvedValue(live([mark(M1, 'A1F', '10.250')]));
    api.withdrawTrenchMark.mockResolvedValue(mark(M1, 'A1F', '10.250', true));
    renderScreen(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: /Withdraw the trench mark/ }));
    await waitFor(() => expect(api.withdrawTrenchMark).toHaveBeenCalledWith(PROJECT, FILE, M1));
  });

  it('shows a withdraw refusal', async () => {
    api.getInstallation.mockResolvedValue(live([mark(M1, 'A1F', '10.250')]));
    api.withdrawTrenchMark.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'ALREADY_WITHDRAWN' }),
    );
    renderScreen(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: /Withdraw the trench mark/ }));
    expect(await screen.findByText('This mark was already withdrawn.')).toBeInTheDocument();
  });

  it('zooms to the route of a mark', async () => {
    api.getInstallation.mockResolvedValue(live([mark(M1, 'A1F', '10.250')]));
    const onShow = vi.fn();
    renderScreen(<Harness onShow={onShow} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show on the drawing' }));
    expect(onShow).toHaveBeenCalledWith('A1F');
  });

  it('offers the tool only for has_trench and says why otherwise', async () => {
    api.getInstallation.mockResolvedValue(live([], 'pull_only'));
    renderScreen(<Harness />);
    expect(await screen.findByText(/appears when the answer is/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New trench/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('visible')).toHaveTextContent('false');
  });

  it('is read-only for someone who cannot write', async () => {
    api.getInstallation.mockResolvedValue(live([mark(M1, 'A1F', '10.250')]));
    renderScreen(<Harness canEdit={false} />);
    await screen.findByText('A1F');
    expect(screen.queryByRole('button', { name: /New trench/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Withdraw the trench mark/ }),
    ).not.toBeInTheDocument();
  });

  it('turns the tool on, takes the length in metres and saves a mark on the route', async () => {
    api.getInstallation.mockResolvedValue(live([]));
    api.createTrenchMark.mockResolvedValue(mark(M1, 'A1F', '25.500'));
    renderScreen(<Harness />);
    const toggle = await screen.findByRole('button', { name: 'New trench' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(screen.getByText(/click a piece of a route/)).toBeInTheDocument();
    const input = screen.getByLabelText('Trench length (metres)');
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    await userEvent.type(input, '25.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save the trench mark' }));
    await waitFor(() =>
      expect(api.createTrenchMark).toHaveBeenCalledWith(PROJECT, FILE, {
        routeHandle: 'A1F',
        lengthM: '25.500',
      }),
    );
    expect(
      await screen.findByText('The trench mark is saved. Rebuild to apply it.'),
    ).toBeInTheDocument();
  });

  it('refuses a length that is not metres above zero before asking the server', async () => {
    api.getInstallation.mockResolvedValue(live([]));
    renderScreen(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: 'New trench' }));
    await userEvent.type(screen.getByLabelText('Trench length (metres)'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save the trench mark' }));
    expect(await screen.findByText(/above 0 and up to 100000/)).toBeInTheDocument();
    expect(api.createTrenchMark).not.toHaveBeenCalled();
  });

  it('shows the server refusal for a piece that is not a route', async () => {
    api.getInstallation.mockResolvedValue(live([]));
    api.createTrenchMark.mockRejectedValue(
      new ApiClientError('VALIDATION_FAILED', 422, { reason: 'ROUTE_NOT_FOUND' }),
    );
    renderScreen(<Harness />);
    await userEvent.click(await screen.findByRole('button', { name: 'New trench' }));
    await userEvent.type(screen.getByLabelText('Trench length (metres)'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save the trench mark' }));
    expect(await screen.findByText(/not a route of the drawing/)).toBeInTheDocument();
  });
});
