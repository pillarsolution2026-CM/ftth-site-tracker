import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

/**
 * Round 2, items 25 and 28: the Object Snap feeds every point the user gives — a grip's new place
 * included — so a vertex put on another vertex lands exactly on it (and JOIN can meet them).
 */

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
const ready: DrawingViewState = {
  cadFileId: FILE_ID,
  status: 'ready',
  errorCode: null,
  sizeBytes: 1234,
  renderedAt: '2026-11-09T10:00:00+00:00',
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  Object.values(installationApi).forEach((fn) => fn.mockReset());
  Object.values(boxApi).forEach((fn) => fn.mockReset());
  Object.values(orderApi).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  window.localStorage.clear();
  api.getDrawingViewState.mockResolvedValue(ready);
  api.listDrawingProblems.mockResolvedValue({ total: 0, warningTotal: 0, items: [] });
  api.listCorrections.mockResolvedValue({ items: [], activeCount: 0 });
  api.getDrawingView.mockResolvedValue(testView());
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
  vi.stubGlobal('Path2D', FakePath2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createMockContext() as never);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Object Snap at every point prompt', { timeout: 30_000 }, () => {
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
  const sent = () =>
    (
      api.createCorrections.mock.calls[0]?.[2] as {
        items: { correction: Record<string, unknown> }[];
      }
    ).items.map((item) => item.correction);

  async function openWorkspace() {
    renderScreen(
      <DrawingViewer
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE_ID}
        enabled
        canWrite
        canFix
        isGeneral={false}
        isSecondary={false}
        focus={null}
      />,
    );
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
    // Drawing goes on the current layer.
    await user.click(screen.getByRole('button', { name: /^Layer: / }));
    const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
    await user.click(within(list).getByRole('button', { name: 'Route' }));
    return { canvas, user };
  }

  it('a grip dragged near another vertex lands exactly on it (the Endpoint snap), so JOIN can meet them', async () => {
    const { canvas, user } = await openWorkspace();
    // Pick the polyline A (0,0)-(50,0)-(50,25): its grips show.
    await click(user, canvas, 25, 0);
    // Click the grip of its first vertex, then the other line's far end, a little off it.
    await click(user, canvas, 0, 0);
    await user.pointer({ target: canvas, coords: at(99.7, 25.25) });
    expect(screen.getByTestId('snap-marker')).toHaveAttribute('data-mode', 'endpoint');
    await click(user, canvas, 99.7, 25.25);
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    const curve = sent().find((c) => c.kind === 'set_curve') as
      { points: [number, number][] } | undefined;
    expect(curve).toBeDefined();
    expect(curve?.points[0]).toEqual([100, 25]);
  });

  const command = () => screen.getByLabelText('Command');
  const type = async (user: User, text: string) => user.type(command(), `${text}{Enter}`);
  const prompt = () => screen.getByTestId('cad-prompt').textContent ?? '';
  const hover = async (user: User, canvas: Element, x: number, y: number) =>
    user.pointer({ target: canvas, coords: at(x, y) });
  const lineStart = () => {
    const made = sent().find((c) => c.kind === 'add_curve') as { points: [number, number][] };
    return made.points[0];
  };

  it('Shift + right-click at a point prompt offers the one-time overrides; Midpoint takes the midpoint', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'line');
    fireEvent.contextMenu(canvas, { shiftKey: true, clientX: 300, clientY: 200 });
    const menu = await screen.findByRole('menu', { name: 'Object Snap overrides' });
    for (const name of ['From', 'Mid Between 2 Points', 'Endpoint', 'Intersection', 'None']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole('menuitem', { name: 'Midpoint' }));
    // Midpoint is not a running mode: only the override finds it, once.
    await click(user, canvas, 75.2, 25.3);
    await click(user, canvas, 90, 40);
    await type(user, '');
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(lineStart()).toEqual([75, 25]);
  });

  it('FROM: a base point, then an offset typed relative to it', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'line');
    await type(user, 'from');
    expect(prompt()).toContain('from Base point');
    await click(user, canvas, 99.8, 25.2);
    expect(prompt()).toContain('<Offset>');
    await type(user, '@-10,5');
    expect(prompt()).toContain('Specify next point');
    await click(user, canvas, 90, 40);
    await type(user, '');
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(lineStart()).toEqual([90, 30]);
  });

  it('M2P: the point midway between two points', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'line');
    await type(user, 'm2p');
    expect(prompt()).toContain('First point of mid');
    await click(user, canvas, 0.1, 0.1);
    expect(prompt()).toContain('Second point of mid');
    await click(user, canvas, 99.8, 25.2);
    await click(user, canvas, 90, 40);
    await type(user, '');
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    expect(lineStart()).toEqual([50, 12.5]);
  });

  it('every point prompt takes the Object Snap; Select objects does not', async () => {
    const { canvas, user } = await openWorkspace();
    const marker = () => screen.queryByTestId('snap-marker');
    // The point prompts of the drawing commands.
    for (const name of ['line', 'pline', 'circle', 'rectang', 'point', 'arc', 'ellipse']) {
      await type(user, name);
      await hover(user, canvas, 99.8, 25.2);
      expect(marker(), `${name} at its first point`).not.toBeNull();
      await user.keyboard('{Escape}');
    }
    // MOVE: Select objects first (no snap), then the base point (snap).
    await type(user, 'move');
    expect(prompt()).toContain('Select objects');
    await hover(user, canvas, 99.8, 25.2);
    expect(marker()).toBeNull();
    await click(user, canvas, 75, 25);
    await user.keyboard('{Enter}');
    expect(prompt()).toContain('base point');
    await hover(user, canvas, 99.8, 25.3);
    expect(marker()).not.toBeNull();
    await click(user, canvas, 99.8, 25.3);
    expect(prompt()).toContain('second point');
    await hover(user, canvas, 0.1, 0.1);
    expect(marker()).not.toBeNull();
    await user.keyboard('{Escape}');
  });
});

describe('commands typed with the Arabic keyboard layout', { timeout: 30_000 }, () => {
  it('«ة» on the key of M reads as M, and the physical key works on the canvas', async () => {
    renderScreen(
      <DrawingViewer
        projectId={PROJECT}
        revisionId={REVISION}
        cadFileId={FILE_ID}
        enabled
        canWrite
        canFix
        isGeneral={false}
        isSecondary={false}
        focus={null}
      />,
    );
    const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
    await user.type(screen.getByLabelText('Command'), 'ة');
    expect(screen.getByLabelText('Command')).toHaveValue('m');
    await user.clear(screen.getByLabelText('Command'));
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'م', code: 'KeyL' });
    expect(screen.getByLabelText('Command')).toHaveValue('l');
  });
});
