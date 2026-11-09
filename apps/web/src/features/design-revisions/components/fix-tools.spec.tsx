import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DrawingCorrection,
  DrawingCorrectionList,
  DrawingProblemCode,
  DrawingProblemItem,
  DrawingProblemList,
} from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
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

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const USER = { id: '44444444-4444-4444-8444-444444444444', name: 'Mona' };

const place: DrawingProblemItem = {
  x: 1,
  y: 2,
  drawingX: 10,
  drawingY: 20,
  layer: 'Sap',
  handle: 'A1',
  suggestedLayer: null,
  text: null,
  near: null,
};

function problems(
  code: DrawingProblemCode,
  items: Array<Partial<typeof place>> = [{}],
): DrawingProblemList {
  return {
    total: items.length,
    items: [
      {
        code,
        severity: 'warning',
        count: items.length,
        items: items.map((item) => ({ ...place, ...item })),
      },
    ],
  };
}

function mappingView(metresPerUnit = '1') {
  return {
    cadFileId: FILE,
    layers: [
      { name: 'Sap' },
      { name: 'CABINET SITE SUB CABINET' },
      { name: 'JOINT' },
      { name: 'Notes' },
      { name: 'BG' },
    ],
    mapping: {
      metresPerUnit,
      version: 3,
      rules: [
        { source: 'layer', layer: 'JOINT', target: 'joint' },
        { source: 'layer', layer: 'CABINET SITE SUB CABINET', target: 'cabinet', role: 'sub' },
        { source: 'layer', layer: 'BG', target: 'background' },
        { source: 'layer', layer: 'Notes', target: 'label' },
        { source: 'layer', layer: 'Cab', target: 'cabinet', role: 'main' },
        { source: 'block', block: 'HHI', target: 'hhi' },
      ],
    },
  };
}

function correction(overrides: Partial<DrawingCorrection> = {}): DrawingCorrection {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    cadFileId: FILE,
    correction: { kind: 'move_layer', handle: 'A1', toLayer: 'X' },
    problem: { code: 'WRONG_LAYER', handle: 'A1' },
    createdBy: USER,
    createdAt: '2026-11-09T10:00:00.000Z',
    withdrawnBy: null,
    withdrawnAt: null,
    ...overrides,
  };
}

function corrections(items: DrawingCorrection[] = []): DrawingCorrectionList {
  return { items, activeCount: items.filter((i) => i.withdrawnAt === null).length };
}

async function show(code: DrawingProblemCode, items?: Array<Partial<typeof place>>) {
  api.listDrawingProblems.mockResolvedValue(problems(code, items));
  renderScreen(
    <ProblemsSection projectId={PROJECT} revisionId={REVISION} cadFileId={FILE} enabled canFix />,
  );
  const user = userEvent.setup();
  const open = await screen.findByRole('button', { name: 'Fix this place' });
  await user.click(open);
  return user;
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  api.listCorrections.mockResolvedValue(corrections());
  api.createCorrection.mockResolvedValue(correction());
  mappingApi.getMapping.mockResolvedValue(mappingView());
});

describe('fix tools', () => {
  it('WRONG_LAYER: moves to the suggested layer', async () => {
    const user = await show('WRONG_LAYER', [{ suggestedLayer: 'CABINET SITE SUB CABINET' }]);
    await user.click(screen.getByRole('button', { name: /Move to the suggested layer/ }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'move_layer', handle: 'A1', toLayer: 'CABINET SITE SUB CABINET' },
      problem: { code: 'WRONG_LAYER', handle: 'A1' },
    });
  });

  it('WRONG_LAYER: offers only layers with a rule (owner 2026-11-09)', async () => {
    await show('WRONG_LAYER', [{ suggestedLayer: 'NO RULE LAYER' }]);
    expect(screen.queryByRole('button', { name: /suggested layer/ })).not.toBeInTheDocument();
    await screen.findByLabelText('Or another layer');
    expect(screen.queryByRole('option', { name: 'BG' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'JOINT' })).toBeInTheDocument();
  });

  it('WRONG_LAYER: moves to a layer picked from the file layers, not the current one', async () => {
    const user = await show('WRONG_LAYER');
    expect(screen.queryByRole('button', { name: /suggested layer/ })).not.toBeInTheDocument();
    const picker = await screen.findByLabelText('Or another layer');
    expect(screen.queryByRole('option', { name: 'Sap' })).not.toBeInTheDocument();
    const move = screen.getByRole('button', { name: 'Move to this layer' });
    expect(move).toBeDisabled();
    await user.selectOptions(picker, 'JOINT');
    await user.click(move);
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'move_layer', handle: 'A1', toLayer: 'JOINT' },
      problem: { code: 'WRONG_LAYER', handle: 'A1' },
    });
  });

  it('LABEL_MISSING: adds the typed label on the layer, a little above the item', async () => {
    const user = await show('LABEL_MISSING');
    const add = screen.getByRole('button', { name: 'Add the label' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Label text'), ' 1-6 ');
    await user.click(add);
    // Half a metre in drawing units: the mapping says one unit is one metre.
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'add_text', layer: 'Sap', x: 10, y: 20.5, text: '1-6', height: null },
      problem: { code: 'LABEL_MISSING', handle: 'A1' },
    });
  });

  it('LABEL_MISSING: the offset follows the drawing unit', async () => {
    mappingApi.getMapping.mockResolvedValue(mappingView('0.001'));
    const user = await show('LABEL_MISSING');
    await user.type(screen.getByLabelText('Label text'), 'X');
    await user.click(screen.getByRole('button', { name: 'Add the label' }));
    expect(api.createCorrection.mock.calls[0]?.[2].correction).toMatchObject({ y: 520 });
  });

  it('LABEL_TYPE_MISMATCH: edits the label, prefilled', async () => {
    const user = await show('LABEL_TYPE_MISMATCH', [{ text: 'Joint 144' }]);
    const input = screen.getByLabelText('Label text (edit it)');
    expect(input).toHaveValue('Joint 144');
    await user.clear(input);
    await user.type(input, 'Joint 36');
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'set_text', handle: 'A1', text: 'Joint 36' },
      problem: { code: 'LABEL_TYPE_MISMATCH', handle: 'A1' },
    });
  });

  it('LABEL_TYPE_MISMATCH: places an item on a layer mapped to a point type, showing the type', async () => {
    const user = await show('LABEL_TYPE_MISMATCH', [{ text: 'Joint 144' }]);
    await user.click(screen.getByRole('radio', { name: /Place an item of the label's type/ }));
    const picker = await screen.findByLabelText('Layer of the item (its type)');
    expect(screen.getByRole('option', { name: 'JOINT — Joint' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cab — Cabinet' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Notes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /HHI/ })).not.toBeInTheDocument();
    await user.selectOptions(picker, 'JOINT');
    await user.click(screen.getByRole('button', { name: 'Place the item here' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'add_item', layer: 'JOINT', x: 10, y: 20 },
      problem: { code: 'LABEL_TYPE_MISMATCH', handle: 'A1' },
    });
  });

  it('LABEL_LENGTH_MISSING: edits the label with a hint to add the length', async () => {
    const user = await show('LABEL_LENGTH_MISSING', [{ text: 'F 24' }]);
    expect(screen.getByText('Add the length to the label.')).toBeInTheDocument();
    const input = screen.getByLabelText('Label text (edit it)');
    expect(input).toHaveValue('F 24');
    await user.type(input, ' 120');
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'set_text', handle: 'A1', text: 'F 24 120' },
      problem: { code: 'LABEL_LENGTH_MISSING', handle: 'A1' },
    });
  });

  it('ROUTE_SPLIT: merges the pieces named in the "A/B" handle', async () => {
    const user = await show('ROUTE_SPLIT', [{ handle: 'B1/B2/B3' }]);
    expect(screen.getByText('3 pieces will be joined into one cable.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge the pieces into one cable' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'merge_routes', handles: ['B1', 'B2', 'B3'] },
      problem: { code: 'ROUTE_SPLIT', handle: 'B1/B2/B3' },
    });
  });

  it('RING_LABEL_MISMATCH: no tool, says it is fixed in AutoCAD', async () => {
    api.listDrawingProblems.mockResolvedValue(problems('RING_LABEL_MISMATCH'));
    renderScreen(
      <ProblemsSection projectId={PROJECT} revisionId={REVISION} cadFileId={FILE} enabled canFix />,
    );
    expect(await screen.findByText(/This error is fixed in AutoCAD/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix this place' })).not.toBeInTheDocument();
  });

  it('marks a place with an active correction as fixed, in words, and offers no tool', async () => {
    api.listCorrections.mockResolvedValue(corrections([correction()]));
    api.listDrawingProblems.mockResolvedValue(problems('WRONG_LAYER'));
    renderScreen(
      <ProblemsSection projectId={PROJECT} revisionId={REVISION} cadFileId={FILE} enabled canFix />,
    );
    expect(
      await screen.findByText(/Fixed — it will disappear after the rebuild/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix this place' })).not.toBeInTheDocument();
  });

  it('a withdrawn correction does not mark the place as fixed', async () => {
    api.listCorrections.mockResolvedValue(
      corrections([correction({ withdrawnAt: '2026-11-09T11:00:00.000Z', withdrawnBy: USER })]),
    );
    api.listDrawingProblems.mockResolvedValue(problems('WRONG_LAYER'));
    renderScreen(
      <ProblemsSection projectId={PROJECT} revisionId={REVISION} cadFileId={FILE} enabled canFix />,
    );
    expect(await screen.findByRole('button', { name: 'Fix this place' })).toBeInTheDocument();
    expect(screen.queryByText(/Fixed — it will disappear/)).not.toBeInTheDocument();
  });

  it('refetches the corrections after saving, so the place turns pending', async () => {
    const user = await show('ROUTE_SPLIT', [{ handle: 'B1/B2' }]);
    api.listCorrections.mockResolvedValue(
      corrections([
        correction({
          correction: { kind: 'merge_routes', handles: ['B1', 'B2'] },
          problem: { code: 'ROUTE_SPLIT', handle: 'B1/B2' },
        }),
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Merge the pieces into one cable' }));
    expect(await screen.findByText(/Fixed — it will disappear/)).toBeInTheDocument();
  });

  it('shows the reason of a refused correction and keeps the form open', async () => {
    api.createCorrection.mockRejectedValue(
      new ApiClientError('VALIDATION_FAILED', 422, { reason: 'HANDLE_NOT_FOUND' }),
    );
    const user = await show('ROUTE_SPLIT', [{ handle: 'B1/B2' }]);
    await user.click(screen.getByRole('button', { name: 'Merge the pieces into one cable' }));
    expect(await screen.findByText('That element is not in the drawing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge the pieces into one cable' })).toBeEnabled();
  });
});
