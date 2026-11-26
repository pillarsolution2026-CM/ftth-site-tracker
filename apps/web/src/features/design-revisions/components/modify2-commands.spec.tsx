import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

/** Audit 4.2 / 8: EXTEND, EXPLODE, and the Utilities and Clipboard panels. */

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
type User = ReturnType<typeof userEvent.setup>;
const type = async (user: User, text: string) => user.type(command(), `${text}{Enter}`);
const size = { width: 800, height: 600 };
const tf = fitTransform(testView().extents, size);
/** A click on the drawing point (x, y) of the fitted view. */
async function clickAt(user: User, canvas: Element, x: number, y: number) {
  const p = toScreen(tf, size, x, y);
  await user.pointer([
    { keys: '[MouseLeft>]', target: canvas, coords: { clientX: p.x, clientY: p.y } },
    { keys: '[/MouseLeft]' },
  ]);
}
const sent = () =>
  (
    api.createCorrections.mock.calls[0]?.[2] as {
      items: { correction: Record<string, unknown> }[];
    }
  ).items.map((item) => item.correction);
const save = async (user: User) => user.click(screen.getByRole('button', { name: /^Save \(/ }));

describe('QSELECT (audit 2 / 4.2)', { timeout: 30_000 }, () => {
  it('picks by layer; Exclude and Append; the picked objects then go to ERASE', async () => {
    const { user } = await openWorkspace();
    await type(user, 'qselect');
    const dialog = screen.getByRole('dialog', { name: 'Quick Select' });
    await user.selectOptions(within(dialog).getByLabelText('Value'), 'Route');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(history()).toContain('2 item(s) selected.');
    expect(screen.queryByRole('dialog', { name: 'Quick Select' })).toBeNull();
    // Exclude on the current selection: nothing of the two is off Route.
    await type(user, 'qselect');
    const again = screen.getByRole('dialog', { name: 'Quick Select' });
    expect(within(again).getByLabelText('Apply to')).toHaveValue('picked');
    await user.click(within(again).getByLabelText('Exclude from new selection set'));
    await user.click(within(again).getByRole('button', { name: 'OK' }));
    expect(history()).toContain('0 item(s) selected.');
    await type(user, 'qselect');
    const third = screen.getByRole('dialog', { name: 'Quick Select' });
    await user.selectOptions(within(third).getByLabelText('Object type'), 'Line');
    await user.click(within(third).getByRole('button', { name: 'OK' }));
    expect(history()).toContain('1 item(s) selected.');
    await type(user, 'e');
    await save(user);
    expect(sent()).toEqual([{ kind: 'erase_item', handle: 'B' }]);
  });
});

describe('PEDIT basics (audit 4.2)', { timeout: 30_000 }, () => {
  it('Close, then Open in its place; Reverse; Undo; the options it has not say why', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'pe');
    expect(prompt()).toBe('PEDIT Select polyline:');
    await clickAt(user, canvas, 75, 25);
    expect(history()).toMatch(/Object selected is not a polyline/);
    await clickAt(user, canvas, 25, 0);
    expect(prompt()).toBe(
      'PEDIT Enter an option [Close/Join/Width/Edit vertex/Fit/Spline/Decurve/Ltype gen/Reverse/Undo]:',
    );
    await type(user, 'c');
    expect(prompt()).toMatch(/^PEDIT Enter an option \[Open\/Join/);
    await type(user, 'w');
    expect(history()).toMatch(/PEDIT Width is not available/);
    await type(user, 'd');
    expect(history()).toMatch(/PEDIT Decurve is not available/);
    await type(user, 'r');
    await type(user, 'u');
    expect(prompt()).toMatch(/^PEDIT Enter an option \[Open\/Join/);
    await type(user, '');
    expect(prompt()).toBe('Type a command');
    await save(user);
    expect(sent()).toEqual([
      expect.objectContaining({
        kind: 'set_curve',
        handle: 'A',
        points: [
          [0, 0],
          [50, 0],
          [50, 25],
        ],
        closed: true,
      }),
    ]);
  });
});

describe('EXTEND and EXPLODE (audit 4.2)', { timeout: 30_000 }, () => {
  it('EXTEND: a pick extends the end to the nearest edge; B picks boundary edges', async () => {
    const base = testView();
    api.getDrawingView.mockResolvedValue(
      testView({
        entities: [
          ...base.entities,
          {
            handle: 'E1',
            layer: 0,
            color: null,
            kind: 'LINE',
            paths: [[60, 10, 70, 10]],
            texts: [],
          },
          {
            handle: 'W1',
            layer: 0,
            color: null,
            kind: 'LINE',
            paths: [[80, 0, 80, 20]],
            texts: [],
          },
        ],
      }),
    );
    const { canvas, user } = await openWorkspace();
    await type(user, 'ex');
    expect(history()).toMatch(/Current settings: Projection=UCS, Edge=None, Mode=Quick/);
    expect(prompt()).toBe(
      'EXTEND Select object to extend or shift-select to trim or [Boundary edges]:',
    );
    await clickAt(user, canvas, 69, 10);
    expect(prompt()).toBe(
      'EXTEND Select object to extend or shift-select to trim or [Boundary edges/Undo]:',
    );
    await type(user, 'b');
    expect(prompt()).toBe('EXTEND Select boundary edges ... Select objects or <select all>:');
    await user.keyboard('{Escape}');
    await save(user);
    expect(sent()).toEqual([
      expect.objectContaining({
        kind: 'set_curve',
        handle: 'E1',
        points: [
          [60, 10],
          [80, 10],
        ],
      }),
    ]);
  });

  it('EXPLODE turns a polyline into its segments; a block is not exploded', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'x');
    expect(prompt()).toBe('EXPLODE Select objects:');
    await clickAt(user, canvas, 25, 0);
    await clickAt(user, canvas, 21, 20);
    await type(user, '');
    expect(history()).toMatch(/1 was not able to be exploded/);
    await save(user);
    expect(sent()).toEqual([
      { kind: 'erase_item', handle: 'A' },
      expect.objectContaining({
        kind: 'add_curve',
        layer: 'Route',
        points: [
          [0, 0],
          [50, 0],
        ],
        closed: false,
      }),
      expect.objectContaining({
        kind: 'add_curve',
        layer: 'Route',
        points: [
          [50, 0],
          [50, 25],
        ],
        closed: false,
      }),
    ]);
  });
});

describe('Utilities and Clipboard panels (audit 8)', { timeout: 30_000 }, () => {
  it('Measure ▾ starts MEASUREGEOM with its option; the panels hold their tools', async () => {
    const { user } = await openWorkspace();
    const utilities = screen.getByRole('group', { name: 'Utilities' });
    await user.click(within(utilities).getByRole('button', { name: 'Measure ▾' }));
    await user.click(within(utilities).getByRole('menuitem', { name: 'Distance' }));
    expect(prompt()).toBe('MEASUREGEOM Specify first point:');
    await user.keyboard('{Escape}');
    await user.click(within(utilities).getByRole('button', { name: 'Quick Select' }));
    expect(screen.getByRole('dialog', { name: 'Quick Select' })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Quick Select' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    await user.click(within(utilities).getByRole('button', { name: 'ID Point' }));
    expect(prompt()).toBe('ID Specify point:');
    await user.keyboard('{Escape}');
    await user.click(within(utilities).getByRole('button', { name: 'Select All' }));
    expect(history()).toMatch(/4 found/);
    const clipboard = screen.getByRole('group', { name: 'Clipboard' });
    for (const name of ['Paste', 'Cut', 'Copy Clip', 'Copy with Base Point']) {
      expect(within(clipboard).getByRole('button', { name })).toBeInTheDocument();
    }
    const modify = screen.getByRole('group', { name: 'Modify' });
    await user.click(within(modify).getByRole('button', { name: 'More Modify tools' }));
    expect(screen.getByRole('button', { name: 'Extend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explode' })).toBeInTheDocument();
  });
});
