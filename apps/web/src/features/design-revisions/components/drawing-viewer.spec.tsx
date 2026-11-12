import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingCorrection, DrawingProblemList, DrawingViewState } from '@ftth/shared';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import type { ShowPlace } from '../hooks/use-drawing-viewer';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D, type MockContext } from '../model/mock-canvas';
import { DrawingViewer } from './drawing-viewer';

const api = vi.hoisted(() => ({
  getDrawingViewState: vi.fn(),
  requestDrawingView: vi.fn(),
  getDrawingView: vi.fn(),
  listDrawingProblems: vi.fn(),
  listCorrections: vi.fn(),
  createCorrection: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);
const installationApi = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  createTrenchMark: vi.fn(),
  withdrawTrenchMark: vi.fn(),
  setInstallationAnswer: vi.fn(),
}));
vi.mock('@/features/installation/api/installation-api', () => installationApi);
const mappingApi = vi.hoisted(() => ({ getMapping: vi.fn() }));
vi.mock('@/features/cad-mapping/api/mapping-api', () => mappingApi);
const boxApi = vi.hoisted(() => ({
  getBoxTypesReport: vi.fn(),
  getBoxTypeState: vi.fn(),
  listAllBoxes: vi.fn(),
}));
vi.mock('@/features/box-types/api/box-types-api', () => boxApi);
const orderApi = vi.hoisted(() => ({ listWorkOrders: vi.fn(), getWorkOrder: vi.fn() }));
vi.mock('@/features/work-orders/api/work-orders-api', () => orderApi);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';

const state = (status: DrawingViewState['status']): DrawingViewState => ({
  cadFileId: FILE_ID,
  status,
  errorCode: status === 'failed' ? 'RENDER_FAILED' : null,
  sizeBytes: status === 'ready' ? 1234 : null,
  renderedAt: status === 'ready' ? '2026-11-09T10:00:00+00:00' : null,
});

const problemItem = {
  x: 1,
  y: 2,
  drawingX: 21,
  drawingY: 21,
  layer: 'Sap',
  handle: 'A1',
  suggestedLayer: null,
  text: null,
  near: null,
} as const;

const problems: DrawingProblemList = {
  total: 1,
  warningTotal: 0,
  items: [{ code: 'LABEL_MISSING', severity: 'warning', count: 1, items: [problemItem] }],
};

const addTextCorrection: DrawingCorrection = {
  id: '55555555-5555-4555-8555-555555555555',
  cadFileId: FILE_ID,
  correction: { kind: 'add_text', layer: 'Sap', x: 21, y: 21.5, text: 'LBL-7', height: 2 },
  problem: { code: 'LABEL_MISSING', handle: 'A1' },
  createdBy: null,
  createdAt: '2026-11-09T10:00:00.000Z',
  withdrawnBy: null,
  withdrawnAt: null,
};

let ctx: MockContext;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  Object.values(installationApi).forEach((fn) => fn.mockReset());
  Object.values(boxApi).forEach((fn) => fn.mockReset());
  Object.values(orderApi).forEach((fn) => fn.mockReset());
  api.listDrawingProblems.mockResolvedValue(problems);
  api.listCorrections.mockResolvedValue({ items: [], activeCount: 0 });
  api.getDrawingView.mockResolvedValue(testView());
  mappingApi.getMapping.mockResolvedValue({
    cadFileId: FILE_ID,
    layers: [{ name: 'Sap' }],
    mapping: { metresPerUnit: '1', version: 1, rules: [] },
  });
  ctx = createMockContext();
  vi.stubGlobal('Path2D', FakePath2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderViewer(
  props: {
    canWrite?: boolean;
    canFix?: boolean;
    isGeneral?: boolean;
    isSecondary?: boolean;
    focus?: ShowPlace | null;
    onShowOnDrawing?: (place: Omit<ShowPlace, 'nonce'>) => void;
  } = {},
) {
  const {
    canWrite = true,
    canFix = true,
    isGeneral = false,
    isSecondary = false,
    focus = null,
    onShowOnDrawing,
  } = props;
  let setFocus: (value: ShowPlace | null) => void = () => undefined;
  function Harness() {
    const [value, set] = useState<ShowPlace | null>(focus);
    setFocus = set;
    return (
      <DrawingViewer
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE_ID}
        enabled
        canWrite={canWrite}
        canFix={canFix}
        isGeneral={isGeneral}
        isSecondary={isSecondary}
        onShowOnDrawing={onShowOnDrawing}
        focus={value}
      />
    );
  }
  const view = renderScreen(<Harness />);
  return {
    ...view,
    rerenderWith: (value: ShowPlace | null) => act(() => setFocus(value)),
  };
}

const focusOnA1: ShowPlace = { code: 'LABEL_MISSING', handle: 'A1', x: 21, y: 21, nonce: 1 };

describe('DrawingViewer status', () => {
  it('offers «Prepare the view» when there is none, and queues it', async () => {
    api.getDrawingViewState.mockResolvedValue(state('none'));
    api.requestDrawingView.mockResolvedValue(state('queued'));
    renderViewer();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Prepare the view' }));
    expect(api.requestDrawingView).toHaveBeenCalledWith(PROJECT, FILE_ID);
    expect(await screen.findByText('Preparing the drawing…')).toBeInTheDocument();
  });

  it('only tells a user without design:write to ask for it', async () => {
    api.getDrawingViewState.mockResolvedValue(state('none'));
    renderViewer({ canWrite: false, canFix: false });
    expect(await screen.findByText(/Ask a user who may edit the design/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare the view' })).not.toBeInTheDocument();
  });

  it('says it failed and lets the user try again', async () => {
    api.getDrawingViewState.mockResolvedValue(state('failed'));
    renderViewer();
    expect(await screen.findByText(/could not be prepared/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare the view' })).toBeInTheDocument();
  });

  it('polls every 3 s while queued, then loads the view when it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getDrawingViewState
      .mockResolvedValueOnce(state('queued'))
      .mockResolvedValue(state('ready'));
    renderViewer();
    expect(await screen.findByText('Preparing the drawing…')).toBeInTheDocument();
    expect(api.getDrawingView).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => expect(api.getDrawingView).toHaveBeenCalledWith(PROJECT, FILE_ID));
    expect(await screen.findByLabelText(/The drawing: drag to pan/)).toBeInTheDocument();
    expect(api.getDrawingViewState).toHaveBeenCalledTimes(2);
  });
});

describe('DrawingViewer ready', () => {
  beforeEach(() => api.getDrawingViewState.mockResolvedValue(state('ready')));

  it('shows a focusable labelled canvas, layer checkboxes starting from `visible`, and draws', async () => {
    renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    expect(canvas).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('checkbox', { name: /Route/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Hidden/ })).not.toBeChecked();
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
  });

  it('toggling a layer redraws without its entities', async () => {
    renderViewer();
    await screen.findByLabelText(/The drawing: drag to pan/);
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    const user = userEvent.setup();
    ctx.stroke.mockClear();
    await user.click(screen.getByRole('checkbox', { name: /Hidden/ }));
    expect(screen.getByRole('checkbox', { name: /Hidden/ })).toBeChecked();
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    const withHidden = ctx.stroke.mock.calls.length;
    ctx.stroke.mockClear();
    await user.click(screen.getByRole('checkbox', { name: /Hidden/ }));
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    expect(withHidden).toBe(ctx.stroke.mock.calls.length + 1);
  });

  it('searches layers and switches the listed ones on or off together', async () => {
    renderViewer();
    const user = userEvent.setup();
    await screen.findByRole('checkbox', { name: /Route/ });
    await user.type(screen.getByLabelText('Search layers'), 'sa');
    expect(screen.queryByRole('checkbox', { name: /Route/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All off' }));
    expect(screen.getByRole('checkbox', { name: /Sap/ })).not.toBeChecked();
    await user.clear(screen.getByLabelText('Search layers'));
    // «All off» touched the listed layer only.
    expect(screen.getByRole('checkbox', { name: /Route/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'All on' }));
    expect(screen.getByRole('checkbox', { name: /Hidden/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'All off' }));
    expect(screen.getByRole('checkbox', { name: /Route/ })).not.toBeChecked();
  });

  it('zoom buttons and keys change the scale; coordinates read out LTR in drawing units', async () => {
    renderViewer();
    const user = userEvent.setup();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    const coords = screen.getByTestId('drawing-coords');
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 300 } });
    const before = coords.textContent;
    expect(before).toMatch(/X -?\d+\.\d\d {2}Y -?\d+\.\d\d/);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 301 } });
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 300 } });
    const afterButton = coords.textContent;
    expect(afterButton).not.toBe(before);
    canvas.focus();
    await user.keyboard('-');
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 301 } });
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 300 } });
    expect(coords.textContent).toBe(before);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Show the whole drawing' }));
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 301 } });
    await user.pointer({ target: canvas, coords: { clientX: 500, clientY: 300 } });
    expect(coords.textContent).toBe(before);
  });

  it('«show the place» centres the place, highlights its entity and scrolls to the canvas', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerenderWith } = renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    expect(ctx.strokeRect).not.toHaveBeenCalled();
    rerenderWith(focusOnA1);
    const user = userEvent.setup();
    await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalled());
    expect(scroll).toHaveBeenCalled();
    // The place is at the centre of the canvas now.
    await user.pointer({ target: canvas, coords: { clientX: 400, clientY: 300 } });
    expect(screen.getByTestId('drawing-coords')).toHaveTextContent(/X 21\.00\s+Y 21\.00/);
    // 60 units across the shorter side (600 px).
    await user.pointer({ target: canvas, coords: { clientX: 410, clientY: 300 } });
    expect(screen.getByTestId('drawing-coords')).toHaveTextContent(/X 22\.00\s+Y 21\.00/);
  });

  it('uses the metres per unit of the mapping for the 60 m window', async () => {
    mappingApi.getMapping.mockResolvedValue({
      cadFileId: FILE_ID,
      layers: [],
      mapping: { metresPerUnit: '0.5', version: 1, rules: [] },
    });
    const { rerenderWith } = renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    await waitFor(() => expect(mappingApi.getMapping).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    rerenderWith(focusOnA1);
    const user = userEvent.setup();
    await user.pointer({ target: canvas, coords: { clientX: 410, clientY: 300 } });
    // 60 m = 120 units over 600 px: 10 px are 2 units.
    await waitFor(() =>
      expect(screen.getByTestId('drawing-coords')).toHaveTextContent(/X 23\.00\s+Y 21\.00/),
    );
  });

  it('highlights both pieces of a ROUTE_SPLIT place', async () => {
    const { rerenderWith } = renderViewer();
    await screen.findByLabelText(/The drawing: drag to pan/);
    rerenderWith({ code: 'ROUTE_SPLIT', handle: 'A/B', x: 50, y: 25, nonce: 1 });
    await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalledTimes(2));
  });

  it('clicking a problem marker opens the same fix tool, and saving shows the correction at once', async () => {
    const { rerenderWith } = renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    rerenderWith(focusOnA1);
    const user = userEvent.setup();
    // The marker is at the centre once the place is shown.
    await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalled());
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 402, clientY: 301 } },
      { keys: '[/MouseLeft]' },
    ]);
    const panel = await screen.findByRole('dialog', {
      name: 'Details of the place on the drawing',
    });
    expect(within(panel).getByText('Symbol without a label')).toBeInTheDocument();
    const text = within(panel).getByLabelText('Label text');
    api.createCorrection.mockResolvedValue(addTextCorrection);
    api.listCorrections.mockResolvedValue({ items: [addTextCorrection], activeCount: 1 });
    await user.type(text, 'LBL-7');
    ctx.fillText.mockClear();
    await user.click(within(panel).getByRole('button', { name: 'Add the label' }));
    expect(api.createCorrection).toHaveBeenCalledWith(
      PROJECT,
      FILE_ID,
      expect.objectContaining({
        correction: expect.objectContaining({ kind: 'add_text', text: 'LBL-7', layer: 'Sap' }),
        problem: { code: 'LABEL_MISSING', handle: 'A1' },
      }),
    );
    // The new label is drawn on the canvas, and the error mark becomes a green check.
    await waitFor(() => expect(ctx.fillText.mock.calls.map((call) => call[0])).toContain('LBL-7'));
    expect(within(panel).getByText(/Fixed — it will disappear/)).toBeInTheDocument();
    expect(ctx.lineTo).toHaveBeenCalled();
  });

  it('clicking an entity shows its handle, layer and type', async () => {
    renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    const user = userEvent.setup();
    // Fit view: the centre of the canvas is the junction of route A and route B.
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 400, clientY: 300 } },
      { keys: '[/MouseLeft]' },
    ]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('LINE')).toBeInTheDocument();
    expect(within(panel).getByText('Route')).toBeInTheDocument();
    expect(within(panel).getByText('B')).toBeInTheDocument();
  });

  it('read-only users see problem marks but no fix tool in the panel', async () => {
    const { rerenderWith } = renderViewer({ canWrite: false, canFix: false });
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    rerenderWith(focusOnA1);
    const user = userEvent.setup();
    await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalled());
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 400, clientY: 300 } },
      { keys: '[/MouseLeft]' },
    ]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByRole('button', { name: 'Fix this place' })).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Label text')).not.toBeInTheDocument();
  });
});

const ANSWER_ID = '44444444-4444-4444-8444-444444444444';
const MARK_ID = '55555555-5555-4555-8555-555555555551';

function installation(marks: { handle: string; length: string }[] = []) {
  return {
    cadFileId: FILE_ID,
    drawingKind: 'general',
    asked: true,
    answer: {
      id: ANSWER_ID,
      cadFileId: FILE_ID,
      answer: 'has_trench',
      answeredBy: null,
      answeredAt: '2026-11-12T10:00:00.000Z',
    },
    answerHistory: [],
    marks: marks.map((m) => ({
      id: MARK_ID,
      cadFileId: FILE_ID,
      routeHandle: m.handle,
      lengthM: m.length,
      createdBy: null,
      createdAt: '2026-11-12T10:00:00.000Z',
      withdrawnBy: null,
      withdrawnAt: null,
    })),
    activeMarkCount: marks.length,
    activeTrenchM: '0.000',
  };
}

describe('DrawingViewer trench marks of a General (ADR-042)', () => {
  beforeEach(() => {
    api.getDrawingViewState.mockResolvedValue(state('ready'));
  });

  it('picks a route piece, takes the length in metres and saves it as a trench mark', async () => {
    installationApi.getInstallation.mockResolvedValue(installation());
    installationApi.createTrenchMark.mockResolvedValue(
      installation([{ handle: 'B', length: '12.500' }]).marks[0],
    );
    renderViewer({ isGeneral: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New trench' }));
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 400, clientY: 300 } },
      { keys: '[/MouseLeft]' },
    ]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('New trench on the route')).toBeInTheDocument();
    await user.type(within(panel).getByLabelText('Trench length (metres)'), '12.5');
    await user.click(within(panel).getByRole('button', { name: 'Save the trench mark' }));
    await waitFor(() =>
      expect(installationApi.createTrenchMark).toHaveBeenCalledWith(PROJECT, FILE_ID, {
        routeHandle: 'B',
        lengthM: '12.500',
      }),
    );
  });

  it('shows no length form when the tool is off', async () => {
    installationApi.getInstallation.mockResolvedValue(installation());
    renderViewer({ isGeneral: true });
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    await screen.findByRole('button', { name: 'New trench' });
    await userEvent
      .setup()
      .pointer([
        { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 400, clientY: 300 } },
        { keys: '[/MouseLeft]' },
      ]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByLabelText('Trench length (metres)')).not.toBeInTheDocument();
  });

  it('draws the marked route with its length written on it, and lists it', async () => {
    installationApi.getInstallation.mockResolvedValue(
      installation([{ handle: 'A', length: '5.000' }]),
    );
    renderViewer({ isGeneral: true });
    await waitFor(() =>
      expect(ctx.fillText.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringMatching(/^Trench: .*5\.000.* m$/),
      ),
    );
    expect(await screen.findByRole('table', { name: /Trench marks/ })).toBeInTheDocument();
    expect(screen.getByText(/dashed purple line/)).toBeInTheDocument();
  });

  it('zooms to the route of a listed mark', async () => {
    installationApi.getInstallation.mockResolvedValue(
      installation([{ handle: 'A', length: '5.000' }]),
    );
    const onShowOnDrawing = vi.fn();
    renderViewer({ isGeneral: true, onShowOnDrawing });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Show on the drawing' }));
    expect(onShowOnDrawing).toHaveBeenCalledWith({ code: null, handle: 'A', x: null, y: null });
  });

  it('centres on the route of a place that has no point', async () => {
    installationApi.getInstallation.mockResolvedValue(installation());
    const { rerenderWith } = renderViewer({ isGeneral: true });
    await screen.findByLabelText(/The drawing: drag to pan/);
    rerenderWith({ code: null, handle: 'B', x: null, y: null, nonce: 1 });
    // The route is highlighted with a dashed box.
    await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalled());
  });

  it('a read-only user sees the marks but not the tool', async () => {
    installationApi.getInstallation.mockResolvedValue(
      installation([{ handle: 'A', length: '5.000' }]),
    );
    renderViewer({ isGeneral: true, canWrite: false, canFix: false });
    await screen.findByRole('table', { name: /Trench marks/ });
    expect(screen.queryByRole('button', { name: 'New trench' })).not.toBeInTheDocument();
  });

  it('never asks about trench for a Secondary', async () => {
    renderViewer({ isGeneral: false });
    await screen.findByLabelText(/The drawing: drag to pan/);
    expect(installationApi.getInstallation).not.toHaveBeenCalled();
    expect(screen.queryByText(/dashed purple line/)).not.toBeInTheDocument();
  });
});

describe('DrawingViewer box types (ADR-043)', () => {
  const SHAPE_A = `v1-${'a'.repeat(64)}`;
  const SHAPE_B = `v1-${'b'.repeat(64)}`;
  const LINE_A = '11111111-1111-4111-8111-111111111111';
  const LINE_B = '22222222-2222-4222-8222-222222222223';
  const box = (handle: string, x: number, shape: string, boxType: unknown) => ({
    id: `66666666-6666-4666-8666-66666666666${handle.slice(-1)}`,
    revisionId: REVISION,
    featureType: 'box',
    code: handle,
    layer: 'BOX',
    blockName: 'box c',
    sourceKind: 'insert',
    sourceHandle: handle,
    lengthM: null,
    anchor: { x, y: 25 },
    attrs: { drawingAt: { x, y: 25 }, reading: { shape, boxType } },
  });

  beforeEach(() => {
    api.getDrawingViewState.mockResolvedValue(state('ready'));
    boxApi.getBoxTypesReport.mockResolvedValue({
      applies: true,
      gallery: null,
      frozen: null,
      ok: true,
      issueCount: 0,
      issues: [],
      totals: null,
      changedSinceBuild: false,
    });
    boxApi.listAllBoxes.mockResolvedValue([
      box('B1', 40, SHAPE_A, { workOrderLineId: LINE_A, code: 'BX-8', label: 'Box 8 ways' }),
      box('B2', 50, SHAPE_B, null),
      box('B3', 60, `v1-${'c'.repeat(64)}`, null),
    ]);
    // Shape B was chosen after the build; shape C has nothing.
    boxApi.getBoxTypeState.mockResolvedValue({
      cadFileId: FILE_ID,
      drawingKind: 'secondary',
      applies: true,
      active: [
        {
          id: '55555555-5555-4555-8555-555555555550',
          cadFileId: FILE_ID,
          shape: SHAPE_A,
          workOrderLineId: LINE_A,
          createdBy: null,
          createdAt: '2026-11-12T10:00:00.000Z',
        },
        {
          id: '55555555-5555-4555-8555-555555555551',
          cadFileId: FILE_ID,
          shape: SHAPE_B,
          workOrderLineId: LINE_B,
          createdBy: null,
          createdAt: '2026-11-12T10:00:00.000Z',
        },
      ],
      history: [],
      previousVersion: null,
    });
    orderApi.listWorkOrders.mockResolvedValue({ items: [{ id: 'wo' }] });
    orderApi.getWorkOrder.mockResolvedValue({
      items: [
        { id: LINE_A, code: 'BX-8', description: 'Box 8 ways' },
        { id: LINE_B, code: 'BX-4', description: 'Box 4 ways' },
      ],
    });
  });

  it('writes the type next to each box: built, not built yet, and no type', async () => {
    renderViewer({ isSecondary: true });
    await screen.findByLabelText(/The drawing: drag to pan/);
    await waitFor(() => {
      const written = ctx.fillText.mock.calls.map((call) => String(call[0]));
      expect(written.some((text) => text.includes('BX-8'))).toBe(true);
      expect(written).toContain('Box 8 ways');
      expect(written.some((text) => text.includes('BX-4'))).toBe(true);
      expect(written).toContain('Not built yet');
      expect(written).toContain('No type');
    });
  });

  it('can hide the texts', async () => {
    const user = userEvent.setup();
    renderViewer({ isSecondary: true });
    const toggle = await screen.findByRole('checkbox', { name: /Show the type of each box/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    ctx.fillText.mockClear();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    expect(ctx.fillText.mock.calls.map((call) => String(call[0]))).not.toContain('No type');
  });

  it('does not ask for box types on a General', async () => {
    renderViewer({ isGeneral: true });
    await screen.findByLabelText(/The drawing: drag to pan/);
    expect(boxApi.getBoxTypesReport).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: /Show the type of each box/ })).toBeNull();
  });
});
