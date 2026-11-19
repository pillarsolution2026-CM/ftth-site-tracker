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
      expect(within(ribbon).queryByRole('button', { name: /Array|Table/ })).not.toBeInTheDocument();
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
      expect(prompt()).toMatch(/^MOVE Specify base point:$/);
      await type(user, '0,0');
      expect(prompt()).toMatch(/MOVE Specify second point:/);
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
      expect(prompt()).toMatch(/ROTATE Specify rotation angle:/);
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

    it('LINE needs a current layer with a rule; then draws segments, typed or clicked; PLINE closes', async () => {
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
      expect(prompt()).toMatch(/or \[Close\/Undo\]/);
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
      expect(prompt()).toMatch(/OFFSET Specify offset distance <1.0000>:/);
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
      const palette = screen.getByRole('complementary', { name: 'Layers' });
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

    it('LA opens the Layers palette; a new layer like another one becomes current for POINT', async () => {
      const { canvas, user } = await openWorkspace();
      await user.click(screen.getByRole('button', { name: 'Close Layers' }));
      expect(screen.queryByRole('complementary', { name: 'Layers' })).not.toBeInTheDocument();
      await type(user, 'la');
      const palette = screen.getByRole('complementary', { name: 'Layers' });
      await user.click(within(palette).getByRole('button', { name: '+ New layer' }));
      const dialog = screen.getByRole('dialog', { name: 'New layer' });
      await user.click(within(dialog).getByRole('button', { name: 'Add the layer' }));
      expect(within(dialog).getByText('Type the name and pick the layer.')).toBeInTheDocument();
      await user.type(within(dialog).getByLabelText('Layer name'), 'DUCT NEW');
      await user.selectOptions(within(dialog).getByLabelText('Means the same as'), 'Route');
      await user.click(within(dialog).getByRole('button', { name: 'Add the layer' }));
      expect(screen.getByRole('button', { name: 'Layer: DUCT NEW' })).toBeInTheDocument();
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
      await type(user, 'array');
      expect(history()).toMatch(/Unknown command "ARRAY"/);
      await type(user, 'circle');
      await user.keyboard('{Escape}');
      expect(history()).toMatch(/\*Cancel\*/);
      expect(prompt()).toBe('Type a command');
      await type(user, '');
      expect(prompt()).toMatch(/^CIRCLE /);
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
