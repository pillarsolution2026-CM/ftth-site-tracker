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

describe('DrawingViewer CAD ribbon (ADR-047, ADR-050)', () => {
  const size = { width: 800, height: 600 };
  const tf = fitTransform(testView().extents, size);
  const at = (x: number, y: number) => {
    const p = toScreen(tf, size, x, y);
    return { clientX: p.x, clientY: p.y };
  };
  const click = async (
    user: ReturnType<typeof userEvent.setup>,
    canvas: Element,
    x: number,
    y: number,
  ) =>
    user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: at(x, y) },
      { keys: '[/MouseLeft]' },
    ]);
  const sent = () =>
    (
      api.createCorrections.mock.calls[0]?.[2] as {
        items: { correction: Record<string, unknown> }[];
      }
    ).items.map((item) => item.correction);

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

  async function openRibbon() {
    renderViewer();
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument();
    return { canvas, user };
  }
  const tool = (name: string) =>
    within(screen.getByRole('toolbar', { name: 'Drawing tools' })).getByRole('button', {
      name: new RegExp(`^${name}( \\(|$)`),
    });
  const prompt = () => screen.getByTestId('cad-prompt').textContent ?? '';

  it('has no pen for a user who may not fix', async () => {
    renderViewer({ canFix: false });
    await screen.findByLabelText(/The drawing: drag to pan/);
    expect(screen.queryByRole('button', { name: 'Edit the drawing' })).not.toBeInTheDocument();
  });

  it('moves a picked line to another layer and saves it on «Save»', async () => {
    const { canvas, user } = await openRibbon();
    expect(prompt()).toMatch(/Pick a tool/);
    await user.click(tool('To layer'));
    await click(user, canvas, 75, 25);
    expect(prompt()).toMatch(/picked\. Choose the new layer/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('New layer'), 'Sap');
    await user.click(screen.getByRole('button', { name: 'Move to this layer' }));
    expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(sent()).toEqual([{ kind: 'move_layer', handle: 'B', toLayer: 'Sap' }]);
    expect(await screen.findByRole('button', { name: 'Edit the drawing' })).toBeInTheDocument();
  });

  it('picks with a box: a window to the right takes only what is inside it', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Move'));
    await user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: at(19, 23) },
      { target: canvas, coords: at(21, 21) },
      { target: canvas, coords: at(23, 19) },
      { keys: '[/MouseLeft]' },
    ]);
    await waitFor(() => expect(prompt()).toMatch(/1.? picked/));
  });

  it('edits a text in place, and «Cancel» drops the edits without saving', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Edit text'));
    await click(user, canvas, 75, 25);
    expect(prompt()).toMatch(/not a text/);
    await click(user, canvas, 31, 31);
    const input = await screen.findByLabelText('New text');
    expect(input).toHaveValue('F 36 C');
    await user.clear(input);
    await user.type(input, '7way 7/3.5');
    ctx.fillText.mockClear();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(ctx.fillText.mock.calls.map((c) => c[0])).toContain('7way 7/3.5'));
    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(api.createCorrections).not.toHaveBeenCalled();
  });

  it('moves picked items from a base point to a second point', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Move'));
    await click(user, canvas, 75, 25);
    await user.click(screen.getByRole('button', { name: 'Done → points' }));
    expect(prompt()).toMatch(/base point/);
    await click(user, canvas, 60, 25);
    expect(prompt()).toMatch(/new place/);
    ctx.setLineDash.mockClear();
    await user.pointer({ target: canvas, coords: at(60, 35) });
    await waitFor(() => expect(ctx.setLineDash).toHaveBeenCalled());
    await click(user, canvas, 60, 35);
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    const [move] = sent();
    expect(move).toMatchObject({ kind: 'move_item', handle: 'B' });
    expect(move?.dy as number).toBeCloseTo(10, 0);
  });

  it('rotates by a typed angle and scales by a typed factor', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Rotate'));
    await click(user, canvas, 75, 25);
    await user.click(screen.getByRole('button', { name: 'Done → points' }));
    await click(user, canvas, 50, 25);
    await user.type(await screen.findByLabelText('Angle (degrees)'), '90{Enter}');
    await user.click(tool('Scale'));
    // B turned 90° about (50, 25): it is now picked where it is drawn, going up from there.
    await click(user, canvas, 50, 45);
    await user.click(screen.getByRole('button', { name: 'Done → points' }));
    await click(user, canvas, 50, 25);
    const factor = await screen.findByLabelText('Scale factor');
    await user.type(factor, '0');
    expect(screen.getByRole('button', { name: 'Apply the scale' })).toBeDisabled();
    await user.clear(factor);
    await user.type(factor, '2{Enter}');
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(sent().map((c) => c.kind)).toEqual(['rotate_item', 'scale_item']);
    expect(sent()[0]).toMatchObject({ handle: 'B', angle: 90 });
    expect(sent()[1]).toMatchObject({ handle: 'B', factor: 2 });
  });

  it('erases with the E key and Enter, and Ctrl+Z undoes the last edit', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(canvas);
    await user.keyboard('e');
    expect(tool('Erase')).toHaveAttribute('aria-pressed', 'true');
    await click(user, canvas, 75, 25);
    await user.keyboard('{Enter}');
    expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
    await user.keyboard('{Control>}z{/Control}');
    expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
    await click(user, canvas, 75, 25);
    await user.click(screen.getByRole('button', { name: /^Erase \(/ }));
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B' }]);
  });

  it('draws a line and a closed polyline on the current layer', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Line'));
    expect(prompt()).toMatch(/Current layer/);
    await user.selectOptions(screen.getByLabelText('Current layer'), 'Route');
    await click(user, canvas, 10, 10);
    await click(user, canvas, 20, 10);
    await user.click(tool('Polyline'));
    await click(user, canvas, 0, 0);
    await click(user, canvas, 10, 0);
    await click(user, canvas, 10, 10);
    await user.click(screen.getByRole('button', { name: 'Close shape' }));
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    const [line, poly] = sent();
    expect(line).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: false });
    expect((line?.points as number[][]).length).toBe(2);
    expect(poly).toMatchObject({ kind: 'add_curve', layer: 'Route', closed: true });
    expect((poly?.points as number[][]).length).toBe(3);
  });

  it('adds a layer like another one and draws on it', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(screen.getByRole('button', { name: '+ New layer' }));
    const dialog = screen.getByRole('dialog', { name: 'New layer' });
    await user.click(within(dialog).getByRole('button', { name: 'Add the layer' }));
    expect(within(dialog).getByText('Type the name and pick the layer.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Layer name'), 'DUCT NEW');
    await user.selectOptions(within(dialog).getByLabelText('Means the same as'), 'Route');
    await user.click(within(dialog).getByRole('button', { name: 'Add the layer' }));
    expect(screen.getByLabelText('Current layer')).toHaveValue('DUCT NEW');
    await user.click(tool('Item'));
    await click(user, canvas, 40, 40);
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(sent()).toEqual([
      { kind: 'add_layer', layer: 'DUCT NEW', like: 'Route' },
      expect.objectContaining({ kind: 'add_item', layer: 'DUCT NEW' }),
    ]);
  });

  it('keeps the edits and says why when the save is refused', async () => {
    const { canvas, user } = await openRibbon();
    await user.click(tool('Erase'));
    await click(user, canvas, 75, 25);
    await user.click(canvas);
    await user.keyboard('{Enter}');
    api.createCorrections.mockRejectedValue(
      new ApiClientError('VALIDATION_FAILED', 422, { reason: 'HANDLE_NOT_FOUND', handles: ['B'] }),
    );
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(await screen.findByText('That element is not in the drawing')).toBeInTheDocument();
    expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
  });
});
