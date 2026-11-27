import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { DrawingViewer } from './drawing-viewer';

/** Item 33 / audit 4.1: AutoCAD's command line — AutoComplete, recall, recent commands. */

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
  return { canvas, user };
}

const command = () => screen.getByLabelText('Command') as HTMLInputElement;
const prompt = () => screen.getByTestId('cad-prompt').textContent ?? '';
const history = () => screen.getByRole('log', { name: 'Command history' }).textContent ?? '';
const listItems = () =>
  within(screen.getByRole('listbox', { name: 'Command suggestions' })).getAllByRole('option');
const options = () =>
  within(screen.getByRole('listbox', { name: 'Command suggestions' }))
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('command line AutoComplete (item 33)', { timeout: 20_000 }, () => {
  it('«jo» + Enter starts JOIN (was «Unknown command "JO"»)', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'jo{Enter}');
    expect(history()).not.toMatch(/Unknown command/);
    expect(prompt()).toMatch(/^JOIN Select source object/);
  });

  it('lists names and aliases while typing; ↓ picks; Enter takes the highlighted one', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'la');
    expect(options().slice(0, 3)).toEqual(['LA (LAYER)', 'LAYCUR', 'LAYDEL']);
    const first = listItems()[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(listItems()[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    // Wraps to the last one.
    const all = listItems();
    expect(all[all.length - 1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(history()).toMatch(/LAYCUR/);
  });

  it('Space takes the first suggestion; a click on a suggestion starts it', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'mov ');
    expect(prompt()).toBe('MOVE Select objects:');
    await user.keyboard('{Escape}');
    await user.type(command(), 'tri');
    await user.click(screen.getByRole('option', { name: 'TRIM' }));
    expect(prompt()).toMatch(/^TRIM /);
  });

  it('mid-word matches are offered after the prefix matches', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'oin');
    expect(options()).toEqual(['BREAKATPOINT', 'JOIN', 'POINT']);
  });

  it('Esc closes the list and clears the line', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'li');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(command().value).toBe('');
  });

  it('↑ / ↓ on an empty line recall what was typed before', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'l{Enter}');
    await user.type(command(), '0,0{Enter}');
    await user.keyboard('{Escape}');
    await user.click(command());
    await user.keyboard('{ArrowUp}');
    expect(command().value).toBe('0,0');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowUp}');
    expect(command().value).toBe('l');
    await user.keyboard('{ArrowDown}');
    expect(command().value).toBe('0,0');
    await user.keyboard('{ArrowDown}');
    expect(command().value).toBe('');
    await user.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    expect(prompt()).toBe('LINE Specify first point:');
  });

  it('right-click on the command line lists the recent commands', async () => {
    const { user } = await openWorkspace();
    await user.type(command(), 'l{Enter}');
    await user.keyboard('{Escape}');
    await user.type(command(), 'c{Enter}');
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(command());
    const menu = screen.getByRole('menu', { name: 'Recent Commands' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['CIRCLE', 'LINE']);
    await user.click(within(menu).getByRole('menuitem', { name: 'LINE' }));
    expect(prompt()).toBe('LINE Specify first point:');
    expect(screen.queryByRole('menu', { name: 'Recent Commands' })).toBeNull();
  });
});
