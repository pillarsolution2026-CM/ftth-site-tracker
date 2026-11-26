import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { DRAFTING_STORAGE_KEY } from '../hooks/use-drafting';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

/** AutoCAD's status bar and drafting aids under the drawing (owner 2026-11-26, item 14). */

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
const bar = () => screen.getByRole('toolbar', { name: 'Status bar' });
const button = (name: string | RegExp) => within(bar()).getByRole('button', { name });

beforeEach(() => {
  window.localStorage.removeItem(DRAFTING_STORAGE_KEY);
  [api, installationApi, boxApi, orderApi].forEach((m) =>
    Object.values(m).forEach((fn) => fn.mockReset()),
  );
  mappingApi.getMapping.mockReset();
  api.getDrawingViewState.mockResolvedValue(ready);
  api.listDrawingProblems.mockResolvedValue({ total: 0, warningTotal: 0, items: [] });
  api.listCorrections.mockResolvedValue({ items: [], activeCount: 0 });
  api.getDrawingView.mockResolvedValue(testView());
  api.createCorrections.mockResolvedValue({ items: [] });
  mappingApi.getMapping.mockResolvedValue({
    cadFileId: FILE_ID,
    layers: [{ name: 'Route' }],
    mapping: {
      metresPerUnit: '1',
      version: 1,
      rules: [{ source: 'layer', layer: 'Route', target: 'route' }],
    },
  });
  vi.stubGlobal('Path2D', FakePath2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(createMockContext() as never);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  renderScreen(
    <DrawingViewer
      projectId={PROJECT}
      revisionId={REVISION}
      cadFileId={FILE_ID}
      enabled
      canWrite
      canFix
      focus={null}
    />,
  );
  const canvas = await screen.findByLabelText(/The drawing: drag to pan/);
  return { canvas, user: userEvent.setup() };
}

describe('CadStatusBar', { timeout: 20_000 }, () => {
  it('shows the 2D items in AutoCAD order with AutoCAD defaults lit', async () => {
    await open();
    expect(within(bar()).getByText('MODEL')).toBeInTheDocument();
    expect(button('Object snap (F3)')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Polar tracking (F10)')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Ortho mode (F8)')).toHaveAttribute('aria-pressed', 'false');
    expect(button('Show/Hide Lineweight')).toHaveAttribute('aria-pressed', 'false');
    expect(within(bar()).getAllByRole('button', { name: 'Selection filtering' })[0]).toBeDisabled();
    expect(within(bar()).getByText('Decimal')).toBeInTheDocument();
  });

  it('F8 turns Ortho on and Polar off; F3 turns object snap off; the choice is kept', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'F8' });
    expect(button('Ortho mode (F8)')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Polar tracking (F10)')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: 'F3' });
    expect(button('Object snap (F3)')).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(DRAFTING_STORAGE_KEY) ?? '{}')).toMatchObject({
        ortho: true,
        osnap: false,
      }),
    );
  });

  it('the Object Snap ▾ lists the 14 modes and opens Drafting Settings', async () => {
    const { user } = await open();
    await user.click(button('Object snap modes'));
    const menu = screen.getByRole('menu', { name: 'Object snap modes' });
    const items = within(menu).getAllByRole('menuitemcheckbox');
    expect(items).toHaveLength(14);
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Endpoint/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Midpoint/ }));
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Midpoint/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(menu).getByRole('menuitem', { name: /Object Snap Settings/ }));
    const dialog = screen.getByRole('dialog', { name: 'Drafting Settings' });
    expect(within(dialog).getByRole('tab', { name: 'Object Snap' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows the pointer coordinates as X,Y when the file has no CRS', async () => {
    const { canvas, user } = await open();
    await user.pointer({ target: canvas, coords: at(40, 20) });
    expect(screen.getByTestId('status-coords').textContent).toMatch(
      /^40\.\d{4}, 20\.\d{4}, 0\.0000$/,
    );
  });

  it('a LINE point clicked near an endpoint lands on it, with the Endpoint marker', async () => {
    const { canvas, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
    await user.click(screen.getByRole('button', { name: /^Layer: / }));
    const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
    await user.click(within(list).getByRole('button', { name: 'Route' }));
    await user.type(screen.getByLabelText('Command'), 'L{Enter}');
    await user.pointer({ target: canvas, coords: at(99.6, 25.3) });
    expect(screen.getByTestId('snap-marker')).toHaveAttribute('data-mode', 'endpoint');
    expect(screen.getByTestId('snap-tip')).toHaveTextContent('Endpoint');
    await click(user, canvas, 99.6, 25.3);
    await user.type(screen.getByLabelText('Command'), '@0,-10{Enter}{Escape}');
    await user.click(screen.getByRole('button', { name: /^Save \(/ }));
    await waitFor(() => expect(api.createCorrections).toHaveBeenCalled());
    const sent = (
      api.createCorrections.mock.calls[0]?.[2] as { items: { correction: unknown }[] }
    ).items.map((i) => i.correction);
    expect(sent[0]).toMatchObject({
      kind: 'add_curve',
      points: [
        [100, 25],
        [100, 15],
      ],
    });
  });

  it('Clean Screen (Ctrl+0) hides the ribbon and gives it back', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Edit the drawing' }));
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    });
    expect(screen.queryByRole('toolbar', { name: 'Drawing tools' })).not.toBeInTheDocument();
    await user.click(button('Clean Screen (Ctrl+0)'));
    expect(screen.getByRole('toolbar', { name: 'Drawing tools' })).toBeInTheDocument();
  });
});
