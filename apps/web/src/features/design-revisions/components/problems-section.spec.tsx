import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingProblemList } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ProblemsSection } from './problems-section';

const api = vi.hoisted(() => ({
  listDrawingProblems: vi.fn(),
  listCorrections: vi.fn(),
  createCorrection: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);
const mappingApi = vi.hoisted(() => ({ getMapping: vi.fn() }));
vi.mock('@/features/cad-mapping/api/mapping-api', () => mappingApi);
const boxApi = vi.hoisted(() => ({ getBoxTypesReport: vi.fn() }));
vi.mock('@/features/box-types/api/box-types-api', () => boxApi);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

const place = {
  x: 7113.2,
  y: 4573.4,
  drawingX: 7113.2,
  drawingY: 4573.4,
  layer: 'Sap',
  handle: 'A1',
  suggestedLayer: 'CABINET SITE SUB CABINET',
  text: null,
  near: { type: 'cabinet', name: '1-6', layer: 'Sap', distanceM: 21.5 },
} as const;

function list(): DrawingProblemList {
  return {
    total: 3,
    warningTotal: 0,
    items: [
      { code: 'WRONG_LAYER', severity: 'warning', count: 1, items: [place] },
      {
        code: 'ROUTE_SPLIT',
        severity: 'warning',
        count: 2,
        items: [
          { ...place, handle: 'B1', suggestedLayer: null },
          { ...place, handle: 'B2', suggestedLayer: null },
        ],
      },
    ],
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  boxApi.getBoxTypesReport.mockReset();
});

describe('ProblemsSection (work list, ADR-050 part 3)', () => {
  const render = (onShowOnDrawing?: (p: unknown) => void, canFix = false) =>
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={canFix}
        onShowOnDrawing={onShowOnDrawing}
      />,
    );
  const rows = () =>
    screen
      .getAllByRole('button', { expanded: false })
      .concat(screen.getAllByRole('button', { expanded: true }));

  it('shows the total, the progress, one short row per place and the first place opened', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    expect(
      await screen.findByRole('heading', { level: 2, name: /Drawing errors: .*3/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/3.? left — .?0.? of .?3.? fixed/)).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
    const first = screen.getByRole('button', { expanded: true });
    expect(within(first).getByText('On the wrong layer')).toBeInTheDocument();
    expect(within(first).getByText(/Near Cabinet .*1-6/)).toBeInTheDocument();
    // The card: what to do, the layer and where it belongs; coordinates under «details».
    expect(screen.getByText('Move it to the suggested layer.')).toBeInTheDocument();
    expect(screen.getByText('CABINET SITE SUB CABINET')).toBeInTheDocument();
    expect(screen.getByText('ZOOM C 7113.2,4573.4')).toBeInTheDocument();
    expect(screen.getAllByText('7113.2, 4573.4')).toHaveLength(2);
    expect(screen.getByText('Details (coordinates and handle)')).toBeInTheDocument();
  });

  it('has no Ignore without permission, and loads no corrections or mapping', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    await screen.findByText('Move it to the suggested layer.');
    expect(screen.queryByRole('button', { name: /ignore|dismiss/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(api.listCorrections).not.toHaveBeenCalled();
    expect(mappingApi.getMapping).not.toHaveBeenCalled();
  });

  it('says what each error is and what is required, for the place chosen', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    expect(await screen.findByText(/drawn on the layer of another type/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole('button', { name: /Broken route lines/ })[0] as HTMLElement,
    );
    expect(screen.getByText('Join the pieces into one cable.')).toBeInTheDocument();
    expect(screen.getByText(/meet end to end away from any item/)).toBeInTheDocument();
  });

  it('marks severity with an icon and a text alternative', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    const hints = await screen.findAllByRole('img', { name: 'Severity: Warning' });
    expect(hints).toHaveLength(3);
  });

  it('filters the list, and says so when a filter is empty', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    await screen.findByText('Move it to the suggested layer.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Fixed/ }));
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
  });

  it('says so when the drawing has no errors', async () => {
    api.listDrawingProblems.mockResolvedValue({ items: [], total: 0 });
    render();
    expect(await screen.findByText('No drawing errors found.')).toBeInTheDocument();
  });

  it('a row and «Next error» ask the viewer to show the place', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    const onShow = vi.fn();
    render(onShow);
    await screen.findByText('Move it to the suggested layer.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next error' }));
    expect(onShow).toHaveBeenLastCalledWith({
      code: 'ROUTE_SPLIT',
      handle: 'B1',
      x: 7113.2,
      y: 4573.4,
    });
    expect(screen.getByText(/^2 \/ 3$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the place on the drawing' }));
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it('has no «show» button without a viewer', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    render();
    await screen.findByText('Move it to the suggested layer.');
    expect(
      screen.queryByRole('button', { name: 'Show the place on the drawing' }),
    ).not.toBeInTheDocument();
  });

  it('has its own «Box types» section with the shape issues, apart from drawing errors (ADR-043)', async () => {
    const SHAPE = `v1-${'a'.repeat(64)}`;
    api.listDrawingProblems.mockResolvedValue({ total: 0, warningTotal: 0, items: [] });
    boxApi.getBoxTypesReport.mockResolvedValue({
      applies: true,
      gallery: {
        version: 1,
        boxCount: 197,
        shapeCount: 1,
        shapes: [
          {
            shape: SHAPE,
            source: 'block',
            count: 197,
            blockNames: ['box c'],
            sampleHandles: ['B1'],
            preview: null,
          },
        ],
        boxesWithoutShape: 0,
      },
      frozen: null,
      ok: false,
      issueCount: 1,
      issues: [{ code: 'BOX_TYPE_UNSET', shape: SHAPE, boxCount: 197, workOrderLineId: null }],
      totals: null,
      changedSinceBuild: false,
    });
    const onShow = vi.fn();
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
        onShowOnDrawing={onShow}
      />,
    );
    expect(await screen.findByRole('heading', { name: /Box types/ })).toBeInTheDocument();
    expect(screen.getByText(/has no work-order line/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose the line' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show on the drawing' }));
    expect(onShow).toHaveBeenCalledWith({ code: null, handle: 'B1', x: null, y: null });
  });
});
