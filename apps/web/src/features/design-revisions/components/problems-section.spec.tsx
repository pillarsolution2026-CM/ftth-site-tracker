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

describe('ProblemsSection', () => {
  it('shows the total, each place with both coordinates, the layer it belongs on and the nearest item', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: /Drawing errors: .*3/ }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /On the wrong layer/ });
    expect(within(table).getByText('ZOOM C 7113.2,4573.4')).toBeInTheDocument();
    expect(within(table).getAllByText('7113.2, 4573.4')).toHaveLength(2);
    expect(within(table).getByText('A1')).toBeInTheDocument();
    expect(within(table).getByText('CABINET SITE SUB CABINET')).toBeInTheDocument();
    expect(within(table).getByText('1-6')).toBeInTheDocument();
  });

  it('has no Ignore button or ignored counts', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    await screen.findByRole('table', { name: /On the wrong layer/ });
    expect(screen.queryByRole('button', { name: /ignore/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/ignored/i)).not.toBeInTheDocument();
  });

  it('says what each error is and what is required to fix it', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    expect(await screen.findByText(/drawn on the layer of another type/)).toBeInTheDocument();
    expect(screen.getByText('Move it to the suggested layer.')).toBeInTheDocument();
    expect(screen.getByText(/meet end to end away from any item/)).toBeInTheDocument();
    expect(screen.getByText('Join the pieces into one cable.')).toBeInTheDocument();
  });

  it('marks severity with an icon and a text alternative', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    const hints = await screen.findAllByRole('img', { name: 'Severity: Warning' });
    expect(hints).toHaveLength(2);
  });

  it('offers no fix tool and loads no corrections without permission or on a non-draft', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    await screen.findByRole('table', { name: /On the wrong layer/ });
    expect(screen.queryByRole('button', { name: /fix this place/i })).not.toBeInTheDocument();
    expect(api.listCorrections).not.toHaveBeenCalled();
    expect(mappingApi.getMapping).not.toHaveBeenCalled();
  });

  it('says so when the drawing has no errors', async () => {
    api.listDrawingProblems.mockResolvedValue({ items: [], total: 0 });
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    expect(await screen.findByText('No drawing errors found.')).toBeInTheDocument();
  });

  it('has a button beside every place that asks the viewer to show it', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
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
    const buttons = await screen.findAllByRole('button', { name: 'Show the place on the drawing' });
    expect(buttons).toHaveLength(3);
    await userEvent.setup().click(buttons[1] as HTMLElement);
    expect(onShow).toHaveBeenCalledWith({
      code: 'ROUTE_SPLIT',
      handle: 'B1',
      x: 7113.2,
      y: 4573.4,
    });
  });

  it('has no such button without a viewer', async () => {
    api.listDrawingProblems.mockResolvedValue(list());
    renderScreen(
      <ProblemsSection
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE}
        enabled
        canFix={false}
      />,
    );
    await screen.findByRole('table', { name: /On the wrong layer/ });
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
