import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingCorrection, DrawingProblemList, DrawingViewState } from '@ftth/shared';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import type { ShowPlace } from '../hooks/use-drawing-viewer';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D, type MockContext } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

const api = vi.hoisted(() => ({
  getDrawingViewState: vi.fn(),
  requestDrawingView: vi.fn(),
  getDrawingView: vi.fn(),
  listDrawingProblems: vi.fn(),
  listCorrections: vi.fn(),
  createCorrection: vi.fn(),
  createCorrections: vi.fn(),
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

  const openLayers = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Layers' }));
    return screen.getByRole('dialog', { name: 'Layer Properties Manager' });
  };

  it('shows a focusable labelled canvas, layer checkboxes starting from `visible`, and draws', async () => {
    renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    expect(canvas).toHaveAttribute('tabindex', '0');
    await openLayers(userEvent.setup());
    expect(screen.getByRole('checkbox', { name: /Route/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Hidden/ })).not.toBeChecked();
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
  });

  it('toggling a layer redraws without its entities', async () => {
    renderViewer();
    await screen.findByLabelText(/The drawing: drag to pan/);
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
    const user = userEvent.setup();
    await openLayers(user);
    await waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
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
    await openLayers(user);
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

describe(
  'DrawingViewer AutoCAD-like workspace (ADR-047, ADR-050, ADR-051)',
  { timeout: 20_000 },
  () => {
    const size = { width: 800, height: 600 };
    const tf = fitTransform(testView().extents, size);
    const at = (x: number, y: number) => {
      const p = toScreen(tf, size, x, y);
      return { clientX: p.x, clientY: p.y };
    };
    type User = ReturnType<typeof userEvent.setup>;
    const click = async (user: User, canvas: Element, x: number, y: number) =>
      user.pointer([
        { keys: '[MouseLeft>]', target: canvas, coords: at(x, y) },
        { keys: '[/MouseLeft]' },
      ]);
    const drag = async (
      user: User,
      canvas: Element,
      from: [number, number],
      to: [number, number],
    ) =>
      user.pointer([
        { keys: '[MouseLeft>]', target: canvas, coords: at(...from) },
        { target: canvas, coords: at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2) },
        { target: canvas, coords: at(...to) },
        { keys: '[/MouseLeft]' },
      ]);
    const sent = () =>
      (
        api.createCorrections.mock.calls[0]?.[2] as {
          items: { correction: Record<string, unknown> }[];
        }
      ).items.map((item) => item.correction);
    const command = () => screen.getByLabelText('Command');
    /** Types on the command line, then Enter. */
    const type = async (user: User, text: string) => user.type(command(), `${text}{Enter}`);
    const prompt = () => screen.getByTestId('cad-prompt').textContent ?? '';
    const history = () => screen.getByRole('log', { name: 'Command history' }).textContent ?? '';
    const save = async (user: User) => user.click(screen.getByRole('button', { name: /^Save \(/ }));
    const tool = (name: string) =>
      within(screen.getByRole('toolbar', { name: 'Drawing tools' })).getByRole('button', {
        name: name,
      });
    const chooseLayer = async (user: User, name: string) => {
      await user.click(screen.getByRole('button', { name: /^Layer: / }));
      const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
      await user.click(within(list).getByRole('button', { name }));
    };

    beforeEach(() => {
      api.getDrawingViewState.mockResolvedValue(state('ready'));
      api.createCorrections.mockResolvedValue({ items: [] });
      mappingApi.getMapping.mockResolvedValue({
        cadFileId: FILE_ID,
        layers: [{ name: 'Sap' }, { name: 'Route' }],
        mapping: {
          metresPerUnit: '1',
          version: 1,
          rules: [
            { source: 'layer', layer: 'Sap', target: 'label' },
            { source: 'layer', layer: 'Route', target: 'route' },
          ],
        },
      });
    });

    async function openWorkspace() {
      renderViewer();
      const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
      expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument();
      return { canvas, user };
    }

    it('has no pen for a user who may not fix', async () => {
      renderViewer({ canFix: false });
      await screen.findByLabelText(/The drawing: drag to pan/);
      expect(screen.queryByRole('button', { name: 'Edit the drawing' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    });

    it('opens a dark Home ribbon and the command line on a black canvas with a crosshair', async () => {
      const fills: string[] = [];
      ctx.fillRect.mockImplementation(() => {
        fills.push(ctx.fillStyle);
      });
      const { canvas, user } = await openWorkspace();
      const ribbon = screen.getByRole('toolbar', { name: 'Drawing tools' });
      for (const panel of ['Draw', 'Modify', 'Annotation', 'Layers', 'Properties']) {
        expect(within(ribbon).getByRole('group', { name: panel })).toBeInTheDocument();
      }
      for (const name of ['Line', 'Polyline', 'Circle', 'Arc', 'Rectangle', 'Trim', 'Fillet']) {
        expect(tool(name)).toBeInTheDocument();
      }
      expect(within(ribbon).queryByRole('button', { name: /^Table$/ })).not.toBeInTheDocument();
      expect(tool('Move')).toHaveAttribute('title', expect.stringMatching(/MOVE \(M\)$/));
      expect(prompt()).toBe('Type a command');
      await waitFor(() => expect(fills).toContain('#000000'));
      await user.pointer({ target: canvas, coords: at(40, 20) });
      expect(screen.getByTestId('crosshair')).toBeInTheDocument();
    });

    it('noun-verb: a picked line moves to the layer chosen in the drop-down', async () => {
      const { canvas, user } = await openWorkspace();
      await click(user, canvas, 75, 25);
      await chooseLayer(user, 'Sap');
      expect(history()).toMatch(/1 object\(s\) changed to layer "Sap"/);
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      await save(user);
      expect(sent()).toEqual([{ kind: 'move_layer', handle: 'B', toLayer: 'Sap' }]);
      expect(await screen.findByRole('button', { name: 'Edit the drawing' })).toBeInTheDocument();
    });

    it('a window to the right picks what is inside; a typed MOVE then asks for the base point', async () => {
      const { canvas, user } = await openWorkspace();
      await drag(user, canvas, [19, 23], [23, 19]);
      await type(user, 'm');
      expect(prompt()).toBe('MOVE Specify base point or [Displacement] <Displacement>:');
      await type(user, '0,0');
      expect(prompt()).toBe('MOVE Specify second point or <use first point as displacement>:');
      await type(user, '@0,10');
      await save(user);
      expect(sent()).toEqual([{ kind: 'move_item', handle: 'A1', dx: 0, dy: 10 }]);
    });

    it('verb-noun MOVE by clicks: select, Enter, base point, second point with a ghost', async () => {
      const { canvas, user } = await openWorkspace();
      await user.click(tool('Move'));
      expect(prompt()).toMatch(/MOVE Select objects:/);
      await click(user, canvas, 75, 25);
      expect(history()).toMatch(/1 found/);
      await type(user, '');
      expect(prompt()).toMatch(/base point/);
      await click(user, canvas, 60, 25);
      ctx.setLineDash.mockClear();
      await user.pointer({ target: canvas, coords: at(60, 35) });
      await waitFor(() => expect(ctx.setLineDash).toHaveBeenCalled());
      await click(user, canvas, 60, 35);
      await save(user);
      const [move] = sent();
      expect(move).toMatchObject({ kind: 'move_item', handle: 'B' });
      expect(move?.dy as number).toBeCloseTo(10, 0);
    });

    it('ROTATE takes a typed angle; SCALE refuses a zero factor and takes 2', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'ro');
      await click(user, canvas, 75, 25);
      await type(user, '');
      await click(user, canvas, 50, 25);
      expect(prompt()).toBe('ROTATE Specify rotation angle or [Copy/Reference] <0>:');
      await type(user, '90');
      // B turned 90° about (50, 25): it is picked where it is drawn now.
      await type(user, 'sc');
      await click(user, canvas, 50, 45);
      await type(user, '');
      await type(user, '50,25');
      await type(user, '0');
      expect(history()).toMatch(/scale factor from 0.001 to 1000/);
      await type(user, '2');
      await save(user);
      expect(sent().map((c) => c.kind)).toEqual(['rotate_item', 'scale_item']);
      expect(sent()[0]).toMatchObject({ handle: 'B', angle: 90 });
      expect(sent()[1]).toMatchObject({ handle: 'B', factor: 2, x: 50, y: 25 });
    });

    it('typing on the canvas goes to the command line; E, Enter, Ctrl+Z and Delete', async () => {
      const { canvas, user } = await openWorkspace();
      await user.click(canvas);
      await user.keyboard('e');
      expect(command()).toHaveValue('e');
      await user.keyboard('{Enter}');
      expect(prompt()).toMatch(/ERASE Select objects:/);
      await click(user, canvas, 75, 25);
      await user.keyboard('{Enter}');
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      await user.keyboard('{Control>}z{/Control}');
      expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
      await click(user, canvas, 75, 25);
      await user.keyboard('{Delete}');
      await save(user);
      expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B' }]);
    });

    it('the tab strip next to Home: Undo and Redo one step, Ctrl+Y; a new edit empties Redo', async () => {
      const { canvas, user } = await openWorkspace();
      const ribbon = screen.getByRole('toolbar', { name: 'Drawing tools' });
      const undo = within(ribbon).getByRole('button', { name: 'Undo (Ctrl+Z)' });
      const redo = within(ribbon).getByRole('button', { name: 'Redo (Ctrl+Y)' });
      expect(undo).toBeDisabled();
      expect(redo).toBeDisabled();
      await click(user, canvas, 75, 25);
      await user.keyboard('{Delete}');
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      await user.click(undo);
      expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
      expect(redo).toBeEnabled();
      await user.click(redo);
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      expect(redo).toBeDisabled();
      await user.click(canvas);
      await user.keyboard('{Control>}z{/Control}');
      expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
      await user.keyboard('{Control>}y{/Control}');
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      // Undo, then a new edit: nothing is left to redo (as in AutoCAD).
      await user.click(undo);
      await click(user, canvas, 75, 25);
      await user.keyboard('{Delete}');
      expect(redo).toBeDisabled();
      await save(user);
      expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B' }]);
    });

    it('the tab strip hides and shows the error markers', async () => {
      const { user } = await openWorkspace();
      const codes = () => ctx.fillText.mock.calls.map((call) => call[0] as string);
      await waitFor(() => expect(codes()).toContain('LABEL_MISSING'));
      const ribbon = screen.getByRole('toolbar', { name: 'Drawing tools' });
      ctx.fillText.mockClear();
      await user.click(within(ribbon).getByRole('button', { name: 'Hide the error markers' }));
      const show = within(ribbon).getByRole('button', { name: 'Show the error markers' });
      expect(show).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(ctx.fillText).toHaveBeenCalled());
      expect(codes()).not.toContain('LABEL_MISSING');
      ctx.fillText.mockClear();
      await user.click(show);
      await waitFor(() => expect(codes()).toContain('LABEL_MISSING'));
    });

    it('OpenStreetMap needs the file CRS', async () => {
      await openWorkspace();
      const map = tool('OpenStreetMap');
      expect(map).toBeDisabled();
      expect(map).toHaveAttribute('title', expect.stringMatching(/needs the file's CRS/));
    });

    it('OpenStreetMap is shown under the drawing on demand and hidden again', async () => {
      const mapped = await mappingApi.getMapping();
      mappingApi.getMapping.mockResolvedValue({
        ...mapped,
        mapping: { ...mapped.mapping, crsEpsg: 32636, drawingUnit: 'm', placement: null },
      });
      const { user } = await openWorkspace();
      const map = tool('OpenStreetMap');
      await waitFor(() => expect(map).toBeEnabled());
      // Nothing of the map is there before it is asked for.
      expect(screen.queryByTestId('osm-backdrop')).not.toBeInTheDocument();
      ctx.clearRect.mockClear();
      await user.click(map);
      expect(map).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('osm-backdrop')).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: '© OpenStreetMap contributors' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(ctx.clearRect).toHaveBeenCalled());
      await user.click(map);
      expect(screen.queryByTestId('osm-backdrop')).not.toBeInTheDocument();
    });

    it('full screen puts the whole workspace on the screen, and the same button leaves it', async () => {
      const request = vi.fn(function (this: Element) {
        Object.defineProperty(document, 'fullscreenElement', {
          configurable: true,
          value: this,
        });
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      });
      const exit = vi.fn(() => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      });
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: request,
      });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
      try {
        const { user } = await openWorkspace();
        await user.click(screen.getByRole('button', { name: 'Full screen' }));
        expect(request).toHaveBeenCalledTimes(1);
        const ribbon = screen.getByRole('toolbar', { name: 'Drawing tools' });
        expect(request.mock.contexts[0]).toContainElement(ribbon);
        expect(request.mock.contexts[0]).toContainElement(screen.getByLabelText('Command'));
        await user.click(screen.getByRole('button', { name: 'Exit full screen' }));
        expect(exit).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument();
      } finally {
        delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
        delete (document as { exitFullscreen?: unknown }).exitFullscreen;
        delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      }
    });

    describe('right-click menu on picked objects (owner 2026-11-24)', () => {
      const rightClick = async (user: User, canvas: Element, x: number, y: number) =>
        user.pointer({ keys: '[MouseRight]', target: canvas, coords: at(x, y) });
      const menu = () => screen.getByRole('menu', { name: 'Menu of the picked objects' });
      const item = (name: string) => within(menu()).getByRole('menuitem', { name });

      it('right-click on an object picks it and shows only the chosen items; Erase erases it', async () => {
        const { canvas, user } = await openWorkspace();
        await rightClick(user, canvas, 75, 25);
        const names = within(menu())
          .getAllByRole('menuitem')
          .map((element) => element.textContent?.replace('›', '').trim());
        expect(names).toEqual([
          'Isolate',
          'Erase',
          'Move',
          'Copy Selection',
          'Scale',
          'Rotate',
          'Draw Order',
          'Group',
          'Add Selected',
          'Select Similar',
          'Deselect All',
          'Properties',
        ]);
        await user.click(item('Draw Order'));
        const order = screen.getByRole('menu', { name: 'Draw Order' });
        expect(
          within(order)
            .getAllByRole('menuitem')
            .map((element) => element.textContent?.trim()),
        ).toEqual(['Bring to Front', 'Send to Back', 'Bring Above Objects', 'Send Under Objects']);
        await user.click(item('Erase'));
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
        await save(user);
        expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B' }]);
      });

      it('Move from the menu asks for the base point of the picked object', async () => {
        const { canvas, user } = await openWorkspace();
        await click(user, canvas, 75, 25);
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Move'));
        expect(prompt()).toMatch(/^MOVE Specify base point/);
      });

      it('Hide Objects takes them off the screen; End Object Isolation brings them back', async () => {
        const { canvas, user } = await openWorkspace();
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Isolate'));
        await user.click(
          within(screen.getByRole('menu', { name: 'Isolate' })).getByRole('menuitem', {
            name: 'Hide Objects',
          }),
        );
        // Hidden: a click there picks nothing, so Delete erases nothing.
        await click(user, canvas, 75, 25);
        await user.keyboard('{Delete}');
        expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
        // With nothing picked the menu still ends the isolation.
        await rightClick(user, canvas, 10, 45);
        expect(item('Erase')).toBeDisabled();
        await user.click(item('Isolate'));
        await user.click(
          within(screen.getByRole('menu', { name: 'Isolate' })).getByRole('menuitem', {
            name: 'End Object Isolation',
          }),
        );
        await click(user, canvas, 75, 25);
        await user.keyboard('{Delete}');
        expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
      });

      it('Select Similar picks the same type on the same layer; Deselect All drops them', async () => {
        const view = testView();
        api.getDrawingView.mockResolvedValue({
          ...view,
          entities: [
            ...view.entities,
            {
              handle: 'B2',
              layer: 0,
              color: null,
              kind: 'LINE',
              paths: [[50, 10, 100, 10]],
              texts: [],
            },
          ],
        });
        const { canvas, user } = await openWorkspace();
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Select Similar'));
        expect(history()).toMatch(/2 found/);
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Deselect All'));
        await user.keyboard('{Delete}');
        expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
      });

      it('Add Selected starts the same command on the layer of the picked object', async () => {
        const { canvas, user } = await openWorkspace();
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Add Selected'));
        expect(history()).toMatch(/"Route" is now the current layer/);
        expect(prompt()).toMatch(/^LINE Specify first point/);
      });

      it('Properties shows the details of the picked object', async () => {
        const { canvas, user } = await openWorkspace();
        await rightClick(user, canvas, 75, 25);
        await user.click(item('Properties'));
        const panel = await screen.findByRole('dialog', {
          name: 'Details of the place on the drawing',
        });
        expect(within(panel).getByText('B')).toBeInTheDocument();
      });
    });

    describe('Draw and Modify commands added for the owner (2026-11-24)', () => {
      it('the Draw and Modify panels open their slide-outs and drop-downs', async () => {
        const { user } = await openWorkspace();
        await user.click(screen.getByRole('button', { name: 'More Draw tools' }));
        const more = screen.getByRole('group', { name: 'More Draw tools' });
        for (const name of [
          'Spline Fit',
          'Spline CV',
          'Ray',
          'Construction Line',
          'Multiple Points',
        ]) {
          expect(within(more).getByRole('button', { name })).toBeInTheDocument();
        }
        for (const name of [
          'Divide',
          'Measure',
          'Region',
          'Wipeout',
          'Helix',
          'Donut',
          'Polygon',
        ]) {
          expect(within(more).getByRole('button', { name })).toBeInTheDocument();
        }
        await user.click(screen.getByRole('button', { name: 'Hatch ▾' }));
        const hatch = screen.getByRole('menu', { name: 'Hatch' });
        expect(
          within(hatch)
            .getAllByRole('menuitem')
            .map((m) => m.textContent),
        ).toEqual(['Hatch', 'Gradient', 'Boundary']);
        await user.click(screen.getByRole('button', { name: 'Ellipse ▾' }));
        expect(
          within(screen.getByRole('menu', { name: 'Ellipse' }))
            .getAllByRole('menuitem')
            .map((m) => m.textContent),
        ).toEqual(['Center', 'Axis, End', 'Elliptical Arc']);
        await user.click(screen.getByRole('button', { name: 'More Modify tools' }));
        const modify = screen.getByRole('group', { name: 'More Modify tools' });
        for (const name of ['Break', 'Break at Point', 'Lengthen', 'Reverse', 'Array']) {
          expect(within(modify).getByRole('button', { name })).toBeInTheDocument();
        }
        expect(
          within(modify).getByRole('button', { name: 'Delete Duplicates' }),
        ).toBeInTheDocument();
        expect(within(modify).getByRole('button', { name: 'Draw Order' })).toBeInTheDocument();
      });

      it('BREAK takes out the part between two points; the rest is a new line', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'br');
        expect(prompt()).toBe('BREAK Select object:');
        await click(user, canvas, 60, 25);
        expect(prompt()).toBe('BREAK Specify second break point or [First point]:');
        await type(user, '80,25');
        await save(user);
        expect(sent()).toEqual([
          {
            kind: 'set_curve',
            handle: 'B',
            points: [
              [50, 25],
              [60, 25],
            ],
            closed: false,
          },
          {
            kind: 'add_curve',
            layer: 'Route',
            points: [
              [80, 25],
              [100, 25],
            ],
            closed: false,
          },
        ]);
      });

      it('LENGTHEN DElta makes the picked end longer; REVERSE turns a line round', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'len');
        await type(user, 'de');
        await type(user, '10');
        expect(prompt()).toBe('LENGTHEN Select an object to change or [Undo]:');
        await click(user, canvas, 95, 25);
        await type(user, '');
        await click(user, canvas, 75, 25);
        await type(user, 'reverse');
        await save(user);
        expect(sent()).toEqual([
          {
            kind: 'set_curve',
            handle: 'B',
            points: [
              [50, 25],
              [110, 25],
            ],
            closed: false,
          },
          {
            kind: 'set_curve',
            handle: 'B',
            points: [
              [110, 25],
              [50, 25],
            ],
            closed: false,
          },
        ]);
      });

      it('ARRAYRECT COUnt makes the copies in columns and rows', async () => {
        const { canvas, user } = await openWorkspace();
        await click(user, canvas, 75, 25);
        await type(user, 'ar');
        expect(prompt()).toMatch(/^ARRAYRECT Select array option or \[COUnt/);
        await type(user, 'cou');
        await type(user, '3');
        await type(user, '1');
        await type(user, '');
        await save(user);
        expect(sent()).toEqual([
          { kind: 'copy_item', handle: 'B', dx: 75, dy: 0 },
          { kind: 'copy_item', handle: 'B', dx: 150, dy: 0 },
        ]);
      });

      it('OVERKILL erases the objects that repeat another', async () => {
        const view = testView();
        api.getDrawingView.mockResolvedValue({
          ...view,
          entities: [
            ...view.entities,
            {
              handle: 'B2',
              layer: 0,
              color: null,
              kind: 'LINE',
              paths: [[50, 25, 100, 25]],
              texts: [],
            },
          ],
        });
        const { user } = await openWorkspace();
        await type(user, 'overkill');
        await type(user, 'all');
        await type(user, '');
        expect(history()).toMatch(/1 duplicate\(s\) deleted/);
        await save(user);
        expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B2' }]);
      });

      it('Draw Order from the right-click menu brings the object to the front', async () => {
        const { canvas, user } = await openWorkspace();
        await user.pointer({ keys: '[MouseRight]', target: canvas, coords: at(75, 25) });
        const menu = screen.getByRole('menu', { name: 'Menu of the picked objects' });
        await user.click(within(menu).getByRole('menuitem', { name: 'Draw Order' }));
        await user.click(
          within(screen.getByRole('menu', { name: 'Draw Order' })).getByRole('menuitem', {
            name: 'Bring to Front',
          }),
        );
        await save(user);
        expect(sent()).toEqual([{ kind: 'set_order', handle: 'B', order: 1 }]);
      });

      it('POLYGON, ELLIPSE and SPLINE draw polylines on the current layer', async () => {
        const { user } = await openWorkspace();
        await chooseLayer(user, 'Route');
        await type(user, 'pol');
        await type(user, '4');
        await type(user, '50,25');
        await type(user, '');
        await type(user, '10');
        await type(user, 'el');
        await type(user, '0,0');
        await type(user, '20,0');
        await type(user, '5');
        await type(user, 'spl');
        await type(user, '0,0');
        await type(user, '10,10');
        await type(user, '20,0');
        await type(user, '');
        await save(user);
        const [square, ellipse, spline] = sent();
        expect(square).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: true });
        expect((square?.points as number[][]).length).toBe(4);
        expect(square?.points).toContainEqual([50, 35]);
        expect(ellipse).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: true });
        expect((ellipse?.points as number[][])[0]).toEqual([20, 0]);
        expect(spline).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: false });
        expect((spline?.points as number[][]).length).toBeGreaterThan(10);
        expect(spline?.points).toContainEqual([10, 10]);
      });

      it('HATCH fills the closed object around the picked point; DONUT and XLINE are screen shapes', async () => {
        const { user } = await openWorkspace();
        await chooseLayer(user, 'Sap');
        await type(user, 'h');
        expect(history()).toMatch(/Pattern = ANSI31, Scale = 1.0000, Angle = 0.0000/);
        await type(user, '21,21');
        await type(user, '');
        await type(user, 'do');
        await type(user, '');
        await type(user, '2');
        await type(user, '10,10');
        await type(user, '');
        await type(user, 'xl');
        await type(user, '0,0');
        await type(user, '1,1');
        await type(user, '');
        await save(user);
        const [hatch, donut, xline] = sent();
        expect(hatch).toMatchObject({
          kind: 'add_shape',
          shape: 'hatch',
          layer: 'Sap',
          pattern: 'ANSI31',
          scale: 1,
        });
        expect((hatch?.points as number[][]).length).toBe(4);
        expect(donut).toMatchObject({ kind: 'add_shape', shape: 'donut', inner: 0.5, outer: 2 });
        expect(xline).toMatchObject({
          kind: 'add_shape',
          shape: 'xline',
          points: [
            [0, 0],
            [1, 1],
          ],
        });
      });

      it('DIVIDE puts points on the current layer along the picked line', async () => {
        const { canvas, user } = await openWorkspace();
        await chooseLayer(user, 'Sap');
        await type(user, 'div');
        await click(user, canvas, 75, 25);
        await type(user, '5');
        expect(history()).toMatch(/4 point\(s\) placed/);
        await save(user);
        expect(sent()).toEqual(
          [60, 70, 80, 90].map((x) => ({ kind: 'add_item', layer: 'Sap', x, y: 25 })),
        );
      });
    });

    it('LINE needs a current layer; then draws segments, typed or clicked; PLINE closes', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'l');
      expect(prompt()).toMatch(/LINE Specify first point:/);
      await click(user, canvas, 10, 10);
      expect(history()).toMatch(/Pick a current layer/);
      await type(user, '');
      await chooseLayer(user, 'Route');
      expect(screen.getByRole('button', { name: 'Layer: Route' })).toBeInTheDocument();
      await type(user, 'line');
      await click(user, canvas, 10, 10);
      await type(user, '@10,0');
      expect(prompt()).toMatch(/Specify next point or \[Undo\]:/);
      await type(user, '');
      await type(user, 'pl');
      await type(user, '0,0');
      await type(user, '10,0');
      await type(user, '10,10');
      expect(prompt()).toBe('PLINE Specify next point or [Arc/Close/Length/Undo]:');
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await save(user);
      const [line, poly] = sent();
      expect(line).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: false });
      expect(line?.points).toEqual([
        [10, 10],
        [20, 10],
      ]);
      expect(poly).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: true });
      expect((poly?.points as number[][]).length).toBe(3);
    });

    it('draws on a layer without a rule as drawing only, and says how to have it counted', async () => {
      const { canvas, user } = await openWorkspace();
      await chooseLayer(user, 'CABINET');
      expect(history()).toMatch(/Layer "CABINET" has no meaning for the build/);
      await type(user, 'rec');
      await click(user, canvas, 10, 10);
      await type(user, '@5,5');
      await save(user);
      expect(sent()).toEqual([
        {
          kind: 'add_curve',
          layer: 'CABINET',
          points: [
            [10, 10],
            [15, 10],
            [15, 15],
            [10, 15],
          ],
          closed: true,
        },
      ]);
    });

    it('a layer without a rule gets a meaning; a new layer may be for drawing only', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'la');
      const manager = screen.getByRole('dialog', { name: 'Layer Properties Manager' });
      // Mapped layers keep their rule; the others say what they mean for the build.
      expect(within(manager).queryByLabelText('What Route means')).not.toBeInTheDocument();
      await user.selectOptions(within(manager).getByLabelText('What CABINET means'), 'Like Route');
      expect(history()).toMatch(/"CABINET" now means the same as "Route"/);
      await user.click(within(manager).getByRole('button', { name: 'New layer' }));
      const form = within(manager).getByRole('group', { name: 'New layer' });
      await user.type(within(form).getByLabelText('Layer name'), 'HOUSES');
      await user.selectOptions(
        within(form).getByLabelText('Means for the build'),
        'Drawing only (not counted)',
      );
      await user.click(within(form).getByRole('button', { name: 'Add the layer' }));
      expect(screen.getByRole('button', { name: 'Layer: HOUSES' })).toBeInTheDocument();
      await user.click(
        within(manager).getByRole('button', { name: 'Close the Layer Properties Manager' }),
      );
      await type(user, 'pl');
      await click(user, canvas, 0, 30);
      await type(user, '@5,0');
      await type(user, '@0,5');
      await type(user, 'c');
      await save(user);
      expect(sent()).toEqual([
        { kind: 'add_layer', layer: 'CABINET', like: 'Route' },
        { kind: 'add_layer', layer: 'HOUSES', like: null },
        expect.objectContaining({ kind: 'add_curve', layer: 'HOUSES', closed: true }),
      ]);
    });

    it('between commands a click picks the item and shows its panel as in the normal view', async () => {
      const { canvas, user } = await openWorkspace();
      await click(user, canvas, 75, 25);
      expect(await screen.findByText('B')).toBeInTheDocument();
      expect(screen.getByLabelText('Color')).toBeEnabled();
      await type(user, 'm');
      expect(prompt()).toMatch(/MOVE Specify base point/);
    });

    it('CIRCLE by centre and radius, RECTANG by two corners, ARC through three points', async () => {
      const { user } = await openWorkspace();
      await chooseLayer(user, 'Route');
      await type(user, 'c');
      await type(user, '50,40');
      expect(prompt()).toMatch(/CIRCLE Specify radius of circle or \[Diameter\]:/);
      await type(user, '5');
      await type(user, 'rec');
      await type(user, '0,0');
      await type(user, '@10,5');
      await type(user, 'a');
      await type(user, '0,0');
      await type(user, '5,5');
      await type(user, '10,0');
      await save(user);
      const [circle, rect, arc] = sent();
      expect(circle).toMatchObject({ kind: 'add_curve', closed: true });
      for (const [x, y] of circle?.points as number[][]) {
        expect(Math.hypot((x as number) - 50, (y as number) - 40)).toBeCloseTo(5, 5);
      }
      expect(rect?.points).toEqual([
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ]);
      expect(arc).toMatchObject({ kind: 'add_curve', closed: false });
      expect((arc?.points as number[][])[0]).toEqual([0, 0]);
    });

    it('TRIM cuts the clicked piece at a cutting edge; OFFSET draws a parallel line', async () => {
      const { canvas, user } = await openWorkspace();
      await chooseLayer(user, 'Route');
      await type(user, 'l');
      await type(user, '75,20');
      await type(user, '75,30');
      await type(user, '');
      await type(user, 'tr');
      await click(user, canvas, 90, 25);
      await type(user, '');
      await type(user, 'o');
      expect(prompt()).toBe('OFFSET Specify offset distance or [Through/Erase/Layer] <1.0000>:');
      await type(user, '2');
      await click(user, canvas, 60, 25);
      await click(user, canvas, 60, 30);
      await type(user, '');
      await save(user);
      const [, trim, offset] = sent();
      expect(trim).toEqual({
        kind: 'set_curve',
        handle: 'B',
        points: [
          [50, 25],
          [75, 25],
        ],
        closed: false,
      });
      expect(offset).toMatchObject({ kind: 'add_curve', layer: 'Route' });
      expect(offset?.points).toEqual([
        [50, 27],
        [75, 27],
      ]);
    });

    it('FILLET with a radius sets both curves, the arc on the first', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'f');
      expect(history()).toMatch(/Radius = 0.0000/);
      await user.click(screen.getByRole('button', { name: 'Radius' }));
      await type(user, '5');
      await click(user, canvas, 50, 10);
      await click(user, canvas, 80, 25);
      await save(user);
      const [a, b] = sent();
      expect(a).toMatchObject({ kind: 'set_curve', handle: 'A' });
      expect(b).toMatchObject({ kind: 'set_curve', handle: 'B' });
      const first = (b?.points as number[][])[0] as number[];
      expect(first[0]).toBeCloseTo(55, 5);
      expect(first[1]).toBeCloseTo(25, 5);
    });

    it('STRETCH moves the vertices in a crossing window; JOIN merges picked lines', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 's');
      await drag(user, canvas, [104, 28], [96, 22]);
      await type(user, '');
      await type(user, '100,25');
      await type(user, '@10,0');
      await type(user, 'j');
      await click(user, canvas, 25, 0);
      await click(user, canvas, 75, 25);
      await type(user, '');
      await save(user);
      const [stretch, join] = sent();
      expect(stretch).toMatchObject({
        kind: 'set_curve',
        handle: 'B',
        points: [
          [50, 25],
          [110, 25],
        ],
      });
      expect(join).toEqual({ kind: 'merge_routes', handles: ['A', 'B'] });
    });

    it('DIMLINEAR and LEADER are saved as notes; TEXTEDIT edits a text in place', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'dli');
      await type(user, '0,0');
      await type(user, '10,0');
      await type(user, '5,5');
      expect(history()).toMatch(/Dimension text = 10.0000/);
      await type(user, 'le');
      await type(user, '0,0');
      await type(user, '5,5');
      await type(user, '');
      expect(prompt()).toMatch(/Enter first line of annotation text/);
      await type(user, 'ODB 1');
      await type(user, 'ed');
      await click(user, canvas, 75, 25);
      expect(history()).toMatch(/Object is not a text/);
      await click(user, canvas, 31, 31);
      expect(command()).toHaveValue('F 36 C');
      await user.clear(command());
      ctx.fillText.mockClear();
      await type(user, '7way 7/3.5');
      await waitFor(() => expect(ctx.fillText.mock.calls.map((c) => c[0])).toContain('7way 7/3.5'));
      await save(user);
      expect(sent()).toEqual([
        {
          kind: 'add_note',
          note: 'dimension',
          layer: '0',
          points: [
            [0, 0],
            [10, 0],
            [5, 5],
          ],
          text: null,
        },
        {
          kind: 'add_note',
          note: 'leader',
          layer: '0',
          points: [
            [0, 0],
            [5, 5],
          ],
          text: 'ODB 1',
        },
        { kind: 'set_text', handle: 'T1', text: '7way 7/3.5' },
      ]);
    });

    it('colour and line type of picked objects are styles; MATCHPROP copies them', async () => {
      const { canvas, user } = await openWorkspace();
      expect(screen.getByLabelText('Color')).toBeDisabled();
      await click(user, canvas, 75, 25);
      await user.selectOptions(screen.getByLabelText('Color'), 'Red');
      await user.selectOptions(screen.getByLabelText('Linetype'), 'DASHED');
      await user.keyboard('{Escape}');
      await type(user, 'ma');
      await click(user, canvas, 75, 25);
      await click(user, canvas, 25, 0);
      await type(user, '');
      await save(user);
      expect(sent()).toEqual([
        { kind: 'set_style', handle: 'B', color: '#ff0000', linetype: 'dashed', lineweight: null },
        { kind: 'set_style', handle: 'A', color: '#ff0000', linetype: 'dashed', lineweight: null },
      ]);
    });

    it('layers: freeze hides and locks keep objects from being picked, for the screen only', async () => {
      const { canvas, user } = await openWorkspace();
      await user.click(screen.getByRole('button', { name: 'Layer Properties' }));
      const palette = screen.getByRole('dialog', { name: 'Layer Properties Manager' });
      await user.click(within(palette).getByRole('button', { name: 'Lock Route' }));
      await click(user, canvas, 75, 25);
      expect(screen.getByLabelText('Color')).toBeDisabled();
      await user.click(within(palette).getByRole('button', { name: 'Lock Route' }));
      // A frozen layer is not drawn, so nothing on it can be picked either.
      await user.click(within(palette).getByRole('button', { name: 'Freeze Route' }));
      expect(within(palette).getByRole('button', { name: 'Freeze Route' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await click(user, canvas, 75, 25);
      expect(screen.getByLabelText('Color')).toBeDisabled();
      await user.click(within(palette).getByRole('button', { name: 'Freeze Route' }));
      await click(user, canvas, 75, 25);
      expect(screen.getByLabelText('Color')).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /^Cancel/ }));
      expect(api.createCorrections).not.toHaveBeenCalled();
    });

    it('LA opens the Layer Properties Manager; a new layer like another one becomes current', async () => {
      const { canvas, user } = await openWorkspace();
      await type(user, 'la');
      const manager = screen.getByRole('dialog', { name: 'Layer Properties Manager' });
      expect(
        within(manager).getByText(/All: .*4.* layers displayed of .*4.* total layers/),
      ).toBeInTheDocument();
      await user.click(within(manager).getByRole('button', { name: 'New layer' }));
      const form = within(manager).getByRole('group', { name: 'New layer' });
      await user.click(within(form).getByRole('button', { name: 'Add the layer' }));
      expect(within(form).getByText('Type the name and pick the layer.')).toBeInTheDocument();
      await user.type(within(form).getByLabelText('Layer name'), 'DUCT NEW');
      await user.selectOptions(within(form).getByLabelText('Means for the build'), 'Like Route');
      await user.click(within(form).getByRole('button', { name: 'Add the layer' }));
      expect(screen.getByRole('button', { name: 'Layer: DUCT NEW' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(
        screen.queryByRole('dialog', { name: 'Layer Properties Manager' }),
      ).not.toBeInTheDocument();
      await type(user, 'po');
      await click(user, canvas, 40, 40);
      await save(user);
      expect(sent()).toEqual([
        { kind: 'add_layer', layer: 'DUCT NEW', like: 'Route' },
        expect.objectContaining({ kind: 'add_item', layer: 'DUCT NEW' }),
      ]);
    });

    it('says so for an unknown command, Esc cancels, Enter repeats the last command', async () => {
      const { user } = await openWorkspace();
      await type(user, '3dorbit');
      expect(history()).toMatch(/Unknown command "3DORBIT"/);
      await type(user, 'circle');
      await user.keyboard('{Escape}');
      expect(history()).toMatch(/\*Cancel\*/);
      expect(prompt()).toBe('Type a command');
      await type(user, '');
      expect(prompt()).toMatch(/^CIRCLE /);
    });

    describe('AutoCAD command options (owner 2026-11-19)', () => {
      const points = (c: Record<string, unknown> | undefined) => c?.points as number[][];
      const last = (c: Record<string, unknown> | undefined) => points(c)[points(c).length - 1];
      const closeTo = (p: number[] | undefined, x: number, y: number) => {
        expect(p?.[0]).toBeCloseTo(x, 4);
        expect(p?.[1]).toBeCloseTo(y, 4);
      };

      it('MOVE Displacement and «use first point as displacement»; COPY mOde Single', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'm');
        await click(user, canvas, 75, 25);
        await type(user, '');
        await type(user, '');
        expect(prompt()).toBe('MOVE Specify displacement <0.0000, 0.0000>:');
        await type(user, '5,0');
        await type(user, 'm');
        await click(user, canvas, 25, 0);
        await type(user, '');
        await type(user, '3,4');
        await type(user, '');
        await type(user, 'co');
        await click(user, canvas, 75, 25);
        await type(user, '');
        await type(user, 'o');
        expect(prompt()).toBe('COPY Enter a copy mode option or [Single/Multiple] <Multiple>:');
        await type(user, 's');
        await type(user, '0,0');
        await type(user, '@0,5');
        expect(prompt()).toBe('Type a command');
        await save(user);
        expect(sent()).toEqual([
          { kind: 'move_item', handle: 'B', dx: 5, dy: 0 },
          { kind: 'move_item', handle: 'A', dx: 3, dy: 4 },
          { kind: 'copy_item', handle: 'B', dx: 0, dy: 5 },
        ]);
      });

      it('ROTATE Copy and Reference; SCALE Reference; MIRROR keeps or erases the source', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'ro');
        await click(user, canvas, 75, 25);
        await type(user, '');
        await type(user, '50,25');
        await type(user, 'c');
        expect(history()).toMatch(/Rotating a copy of the selected objects/);
        await type(user, '90');
        await type(user, 'ro');
        await click(user, canvas, 25, 0);
        await type(user, '');
        await type(user, '0,0');
        await type(user, 'r');
        expect(prompt()).toBe('ROTATE Specify the reference angle <0>:');
        await type(user, '30');
        expect(prompt()).toBe('ROTATE Specify the new angle or [Points] <0>:');
        await type(user, '90');
        await type(user, 'sc');
        await click(user, canvas, 21, 20);
        await type(user, '');
        await type(user, '20,20');
        await type(user, 'r');
        await type(user, '2');
        await type(user, '6');
        await type(user, 'mi');
        await click(user, canvas, 31, 31);
        await type(user, '');
        await type(user, '0,0');
        await type(user, '0,10');
        expect(prompt()).toBe('MIRROR Erase source objects? or [Yes/No] <No>:');
        await type(user, '');
        await save(user);
        expect(sent()).toEqual([
          { kind: 'copy_item', handle: 'B', dx: 0, dy: 0 },
          expect.objectContaining({ kind: 'rotate_item', handle: 'B', angle: 90 }),
          expect.objectContaining({ kind: 'rotate_item', handle: 'A', angle: 60 }),
          expect.objectContaining({ kind: 'scale_item', handle: 'A1', factor: 3 }),
          { kind: 'copy_item', handle: 'T1', dx: 0, dy: 0 },
          expect.objectContaining({ kind: 'mirror_item', handle: 'T1' }),
        ]);
      });

      it('PLINE Arc, Line and Length', async () => {
        const { user } = await openWorkspace();
        await chooseLayer(user, 'Route');
        await type(user, 'pl');
        await type(user, '0,0');
        await type(user, '10,0');
        await type(user, 'a');
        expect(prompt()).toBe('PLINE Specify endpoint of arc or [Line/Second pt/Undo]:');
        await type(user, '20,10');
        await type(user, 'l');
        await type(user, 'l');
        expect(prompt()).toBe('PLINE Specify length of line:');
        await type(user, '5');
        await type(user, '');
        await save(user);
        const [poly] = sent();
        expect(poly).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: false });
        // The arc is tangent to the first line: a quarter circle about (10, 10).
        expect(points(poly).length).toBeGreaterThan(5);
        for (const p of points(poly).slice(1, -1)) {
          expect(Math.hypot((p[0] as number) - 10, (p[1] as number) - 10)).toBeCloseTo(10, 4);
        }
        // Length goes on in the direction the arc ends in (up), 5 units.
        closeTo(last(poly), 20, 15);
      });

      it('CIRCLE Ttr, ARC Center and Start-End-Radius, RECTANG Fillet with Dimensions', async () => {
        const { canvas, user } = await openWorkspace();
        await chooseLayer(user, 'Route');
        await type(user, 'c');
        await type(user, 'ttr');
        expect(prompt()).toBe('CIRCLE Specify point on object for first tangent of circle:');
        await click(user, canvas, 25, 0);
        await click(user, canvas, 50, 12);
        await type(user, '5');
        await type(user, 'a');
        await type(user, 'c');
        await type(user, '0,0');
        await type(user, '10,0');
        await type(user, '-10,0');
        await type(user, 'a');
        await type(user, '10,0');
        await type(user, 'e');
        await type(user, '-10,0');
        await type(user, 'r');
        await type(user, '10');
        await type(user, 'rec');
        await type(user, 'f');
        await type(user, '1');
        expect(history()).toMatch(/Current rectangle modes: {2}Fillet=1.0000/);
        await type(user, '0,0');
        await type(user, 'd');
        await type(user, '10');
        await type(user, '5');
        await type(user, '20,20');
        await save(user);
        const [circle, arcC, arcR, rect] = sent();
        for (const p of points(circle)) {
          expect(Math.hypot((p[0] as number) - 45, (p[1] as number) - 5)).toBeCloseTo(5, 4);
        }
        closeTo(points(arcC)[0], 10, 0);
        closeTo(last(arcC), -10, 0);
        expect(points(arcC).every((p) => (p[1] as number) >= -1e-6)).toBe(true);
        for (const p of points(arcR)) {
          expect(Math.hypot(p[0] as number, p[1] as number)).toBeCloseTo(10, 4);
        }
        expect(rect).toMatchObject({ kind: 'add_curve', closed: true });
        expect(points(rect).length).toBeGreaterThan(4);
        const xs = points(rect).map((p) => p[0] as number);
        expect(Math.max(...xs)).toBeCloseTo(10, 4);
      });

      it('TRIM: shift-select extends, eRase erases, cuTting edges asks for edges', async () => {
        const { canvas, user } = await openWorkspace();
        await chooseLayer(user, 'Route');
        await type(user, 'l');
        await type(user, '110,20');
        await type(user, '110,30');
        await type(user, '');
        await type(user, 'tr');
        expect(prompt()).toBe(
          'TRIM Select object to trim or shift-select to extend or [cuTting edges/eRase/Undo]:',
        );
        await user.keyboard('{Shift>}');
        await click(user, canvas, 95, 25);
        await user.keyboard('{/Shift}');
        await type(user, 't');
        expect(prompt()).toBe('TRIM Select cutting edges ... Select objects or <select all>:');
        await type(user, '');
        await type(user, 'r');
        await click(user, canvas, 31, 31);
        await type(user, '');
        await type(user, '');
        await save(user);
        const [, extend, erase] = sent();
        expect(extend).toEqual({
          kind: 'set_curve',
          handle: 'B',
          points: [
            [50, 25],
            [110, 25],
          ],
          closed: false,
        });
        expect(erase).toEqual({ kind: 'erase_item', handle: 'T1' });
      });

      it('FILLET Polyline rounds every corner; Trim mode «No trim» draws only the arc', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'f');
        await type(user, 'r');
        await type(user, '2');
        await type(user, 'p');
        await click(user, canvas, 25, 0);
        expect(history()).toMatch(/1 lines were filleted/);
        await type(user, 'f');
        await type(user, 't');
        expect(prompt()).toBe('FILLET Enter Trim mode option or [Trim/No trim] <Trim>:');
        await type(user, 'n');
        await type(user, 'r');
        await type(user, '5');
        await click(user, canvas, 50, 10);
        await click(user, canvas, 80, 25);
        await save(user);
        const [poly, arc] = sent();
        expect(poly).toMatchObject({ kind: 'set_curve', handle: 'A' });
        expect(points(poly).length).toBeGreaterThan(3);
        expect(arc).toMatchObject({ kind: 'add_curve', layer: 'Route' });
        expect(sent()).toHaveLength(2);
      });

      it('OFFSET Through a point, and Erase source', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'o');
        await type(user, 't');
        await click(user, canvas, 75, 25);
        expect(prompt()).toBe('OFFSET Specify through point or [Exit/Multiple/Undo] <Exit>:');
        await click(user, canvas, 75, 28);
        await type(user, '');
        await type(user, 'o');
        await type(user, 'e');
        await type(user, 'y');
        await type(user, '2');
        await click(user, canvas, 25, 0);
        await click(user, canvas, 25, -5);
        await type(user, '');
        await save(user);
        const [through, offset, erase] = sent();
        expect(through).toMatchObject({ kind: 'add_curve', layer: 'Route' });
        closeTo(points(through)[0], 50, 28);
        expect(offset).toMatchObject({ kind: 'add_curve', layer: 'Route' });
        closeTo(points(offset)[0], 0, -2);
        expect(erase).toEqual({ kind: 'erase_item', handle: 'A' });
      });

      it('DIMLINEAR <select object>, Text and Horizontal; LAYMCH Name; selection ALL and Remove', async () => {
        const { canvas, user } = await openWorkspace();
        await type(user, 'dli');
        expect(prompt()).toBe('DIMLINEAR Specify first extension line origin or <select object>:');
        await type(user, '');
        await click(user, canvas, 75, 25);
        await type(user, 't');
        await type(user, '50 m');
        await type(user, 'h');
        await type(user, '75,30');
        expect(history()).toMatch(/Dimension text = 50 m/);
        await click(user, canvas, 75, 25);
        await type(user, 'laymch');
        await type(user, 'n');
        await type(user, 'Sap');
        await type(user, 'm');
        await type(user, 'all');
        expect(history()).toMatch(/4 found/);
        await type(user, 'r');
        expect(prompt()).toBe('MOVE Remove objects:');
        await click(user, canvas, 75, 25);
        await type(user, '');
        await type(user, '0,0');
        await type(user, '@1,0');
        await save(user);
        expect(sent()).toEqual([
          {
            kind: 'add_note',
            note: 'dimension',
            layer: '0',
            points: [
              [50, 25],
              [100, 25],
              [75, 30],
            ],
            text: '50 m',
          },
          { kind: 'move_layer', handle: 'B', toLayer: 'Sap' },
          { kind: 'move_item', handle: 'A', dx: 1, dy: 0 },
          { kind: 'move_item', handle: 'A1', dx: 1, dy: 0 },
          { kind: 'move_item', handle: 'T1', dx: 1, dy: 0 },
        ]);
      });
    });

    it('keeps the edits and says why when the save is refused', async () => {
      const { canvas, user } = await openWorkspace();
      await click(user, canvas, 75, 25);
      await type(user, 'e');
      api.createCorrections.mockRejectedValue(
        new ApiClientError('VALIDATION_FAILED', 422, {
          reason: 'HANDLE_NOT_FOUND',
          handles: ['B'],
        }),
      );
      await save(user);
      expect(await screen.findByText('That element is not in the drawing')).toBeInTheDocument();
      expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
    });
  },
);
