import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingProblemList } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ProblemsSection } from './problems-section';

const api = vi.hoisted(() => ({
  listDrawingProblems: vi.fn(),
  ignoreDrawingProblem: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';

function list(ignoredAt: string | null = null): DrawingProblemList {
  return {
    items: [
      {
        code: 'WRONG_LAYER',
        severity: 'warning',
        count: 1,
        ignoredCount: ignoredAt ? 1 : 0,
        items: [
          {
            x: 7113.2,
            y: 4573.4,
            drawingX: 7113.2,
            drawingY: 4573.4,
            layer: 'Sap',
            handle: 'A1',
            suggestedLayer: 'CABINET SITE SUB CABINET',
            text: null,
            near: { type: 'cabinet', name: '1-6', layer: 'Sap', distanceM: 21.5 },
            ignored: ignoredAt ? { byId: null, at: ignoredAt } : null,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  api.listDrawingProblems.mockReset();
  api.ignoreDrawingProblem.mockReset();
});

describe('ProblemsSection', () => {
  it('shows each problem with its place, the layer it belongs on and the nearest item', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection projectId={PROJECT} revisionId={REVISION} enabled canIgnore={false} />,
    );
    const table = await screen.findByRole('table', { name: /On the wrong layer/ });
    expect(within(table).getByText('ZOOM C 7113.2,4573.4')).toBeInTheDocument();
    expect(within(table).getByText('CABINET SITE SUB CABINET')).toBeInTheDocument();
    expect(within(table).getByText('1-6')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Ignore' })).not.toBeInTheDocument();
  });

  it('ignores a place only after the user takes responsibility', async () => {
    const user = userEvent.setup();
    api.listDrawingProblems.mockResolvedValue(list());
    api.ignoreDrawingProblem.mockResolvedValue(list('2026-11-04T10:00:00.000Z'));
    renderScreen(<ProblemsSection projectId={PROJECT} revisionId={REVISION} enabled canIgnore />);
    await user.click(await screen.findByRole('button', { name: 'Ignore' }));
    expect(api.ignoreDrawingProblem).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Ignore this place' });
    await user.click(within(dialog).getByRole('button', { name: 'I take responsibility: ignore' }));
    expect(api.ignoreDrawingProblem).toHaveBeenCalledWith(PROJECT, REVISION, {
      code: 'WRONG_LAYER',
      handle: 'A1',
      acceptResponsibility: true,
    });
    await waitFor(() =>
      expect(screen.getByText(/Ignored on the user's responsibility/)).toBeInTheDocument(),
    );
  });

  it('says so when the drawing has no problems', async () => {
    api.listDrawingProblems.mockResolvedValue({ items: [] });
    renderScreen(<ProblemsSection projectId={PROJECT} revisionId={REVISION} enabled canIgnore />);
    expect(await screen.findByText('No drawing problems found.')).toBeInTheDocument();
  });
});
