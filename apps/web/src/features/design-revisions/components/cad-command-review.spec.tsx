import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

/**
 * Phase 7 of the AutoCAD-exact drawing screen (owner 2026-11-26, item 19): every existing command
 * checked against AutoCAD 2D — prompts, option words, defaults in < >, repeat, Enter and Undo.
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

describe('AutoCAD review of the existing commands (phase 7)', { timeout: 20_000 }, () => {
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
  const command = () => screen.getByLabelText('Command');
  const type = async (user: User, text: string) => user.type(command(), `${text}{Enter}`);
  const prompt = () => screen.getByTestId('cad-prompt').textContent ?? '';
  const history = () => screen.getByRole('log', { name: 'Command history' }).textContent ?? '';
  const save = async (user: User) => user.click(screen.getByRole('button', { name: /^Save \(/ }));
  const chooseLayer = async (user: User, name: string) => {
    await user.click(screen.getByRole('button', { name: /^Layer: / }));
    const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
    await user.click(within(list).getByRole('button', { name }));
  };

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

  it('question prompts have no «or»; ROTATE and SCALE offer the last angle and factor', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'ro');
    await click(user, canvas, 75, 25);
    await type(user, '');
    await type(user, '50,25');
    expect(prompt()).toBe('ROTATE Specify rotation angle or [Copy/Reference] <0>:');
    await type(user, '90');
    await type(user, 'ro');
    await click(user, canvas, 25, 0);
    await type(user, '');
    await type(user, '0,0');
    expect(prompt()).toBe('ROTATE Specify rotation angle or [Copy/Reference] <90>:');
    await type(user, '');
    await type(user, 'sc');
    await click(user, canvas, 21, 20);
    await type(user, '');
    await type(user, '20,20');
    expect(prompt()).toBe('SCALE Specify scale factor or [Copy/Reference] <1.0000>:');
    await type(user, '2');
    await type(user, 'sc');
    await click(user, canvas, 31, 31);
    await type(user, '');
    await type(user, '30,30');
    expect(prompt()).toBe('SCALE Specify scale factor or [Copy/Reference] <2.0000>:');
    await type(user, '');
    await type(user, 'mi');
    await click(user, canvas, 21, 20);
    await type(user, '');
    await type(user, '0,0');
    await type(user, '0,10');
    expect(prompt()).toBe('MIRROR Erase source objects? [Yes/No] <No>:');
    await type(user, 'y');
    await save(user);
    expect(sent()).toEqual([
      expect.objectContaining({ kind: 'rotate_item', handle: 'B', angle: 90 }),
      expect.objectContaining({ kind: 'rotate_item', handle: 'A', angle: 90 }),
      expect.objectContaining({ kind: 'scale_item', handle: 'A1', factor: 2 }),
      expect.objectContaining({ kind: 'scale_item', handle: 'T1', factor: 2 }),
      expect.objectContaining({ kind: 'mirror_item', handle: 'A1' }),
    ]);
  });

  it('CIRCLE Diameter offers twice the last radius; LINE Enter goes on from the last line', async () => {
    const { user } = await openWorkspace();
    await chooseLayer(user, 'Route');
    await type(user, 'l');
    await type(user, '');
    expect(history()).toMatch(/No line or arc to continue/);
    await type(user, '0,0');
    await type(user, 'u');
    expect(history()).toMatch(/All segments already undone/);
    await type(user, '10,0');
    await type(user, '');
    await type(user, 'l');
    await type(user, '');
    expect(prompt()).toBe('LINE Specify next point or [Undo]:');
    await type(user, '10,10');
    await type(user, '');
    await type(user, 'c');
    await type(user, '0,0');
    await type(user, '5');
    await type(user, 'c');
    await type(user, '20,0');
    await type(user, 'd');
    expect(prompt()).toBe('CIRCLE Specify diameter of circle <10.0000>:');
    await type(user, '');
    await save(user);
    const [first, second, , circle] = sent();
    expect(first).toMatchObject({
      kind: 'add_curve',
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    expect(second).toMatchObject({
      kind: 'add_curve',
      points: [
        [10, 0],
        [10, 10],
      ],
    });
    for (const p of circle?.points as number[][]) {
      expect(Math.hypot((p[0] as number) - 20, p[1] as number)).toBeCloseTo(5, 4);
    }
  });

  it('COPY Array: items a step apart, or fitted up to the point; then [Array/Exit/Undo]', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'co');
    await click(user, canvas, 75, 25);
    await type(user, '');
    await type(user, '0,0');
    expect(prompt()).toBe(
      'COPY Specify second point or [Array] <use first point as displacement>:',
    );
    await type(user, 'a');
    expect(prompt()).toBe('COPY Enter number of items to array:');
    await type(user, '1');
    expect(history()).toMatch(/Requires an integer between 2 and 32767/);
    await type(user, '3');
    expect(prompt()).toBe('COPY Specify second point or [Fit]:');
    await type(user, '@10,0');
    expect(prompt()).toBe('COPY Specify second point or [Array/Exit/Undo] <Exit>:');
    await type(user, 'a');
    await type(user, '3');
    await type(user, 'f');
    expect(prompt()).toBe('COPY Specify second point or [Array]:');
    await type(user, '0,10');
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([
      { kind: 'copy_item', handle: 'B', dx: 10, dy: 0, toLayer: null },
      { kind: 'copy_item', handle: 'B', dx: 20, dy: 0, toLayer: null },
      { kind: 'copy_item', handle: 'B', dx: 0, dy: 5, toLayer: null },
      { kind: 'copy_item', handle: 'B', dx: 0, dy: 10, toLayer: null },
    ]);
  });

  it('TEXT goes on line after line and keeps the height; TEXTEDIT asks for the next text', async () => {
    const { canvas, user } = await openWorkspace();
    await chooseLayer(user, 'Sap');
    await type(user, 't');
    await type(user, '0,0');
    await type(user, '3');
    await type(user, 'ABC');
    expect(prompt()).toBe('TEXT Enter text:');
    await type(user, 'DEF');
    await type(user, '');
    expect(prompt()).toBe('Type a command');
    await type(user, 't');
    expect(history()).toMatch(/Text height: {2}3.0000/);
    await type(user, '50,50');
    expect(prompt()).toBe('TEXT Specify height <3.0000>:');
    await type(user, '');
    await type(user, 'GHI');
    await type(user, '');
    await type(user, 'ed');
    expect(history()).toMatch(/Current settings: Edit mode = Multiple/);
    await click(user, canvas, 31, 31);
    await user.clear(command());
    await type(user, 'X1');
    expect(prompt()).toBe('TEXTEDIT Select an annotation object or [Undo]:');
    await type(user, 'u');
    await click(user, canvas, 31, 31);
    await user.clear(command());
    await type(user, 'X2');
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([
      { kind: 'add_text', layer: 'Sap', x: 0, y: 0, text: 'ABC', height: 3 },
      { kind: 'add_text', layer: 'Sap', x: 0, y: -5, text: 'DEF', height: 3 },
      { kind: 'add_text', layer: 'Sap', x: 50, y: 50, text: 'GHI', height: 3 },
      { kind: 'set_text', handle: 'T1', text: 'X2' },
    ]);
  });

  it('LAYOFF picks one object at a time with Undo; LAYLCK / LAYULK take one object', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'layoff');
    expect(prompt()).toBe('LAYOFF Select an object on the layer to be turned off:');
    await click(user, canvas, 75, 25);
    expect(history()).toMatch(/Layer "Route" has been turned off/);
    expect(prompt()).toBe('LAYOFF Select an object on the layer to be turned off or [Undo]:');
    await type(user, 'u');
    await type(user, '');
    await type(user, 'laylck');
    expect(prompt()).toBe('LAYLCK Select an object on the layer to be locked:');
    await click(user, canvas, 75, 25);
    expect(history()).toMatch(/Layer "Route" has been locked/);
    expect(prompt()).toBe('Type a command');
    await click(user, canvas, 75, 25);
    await user.keyboard('{Delete}');
    expect(screen.queryByText(/edits not saved yet/)).not.toBeInTheDocument();
    await type(user, 'layulk');
    await click(user, canvas, 75, 25);
    expect(history()).toMatch(/Layer "Route" has been unlocked/);
    await click(user, canvas, 75, 25);
    await user.keyboard('{Delete}');
    expect(screen.getByText(/1.? edits not saved yet/)).toBeInTheDocument();
  });

  it('DONUT, ELLIPSE Arc, SPLINE and HELIX prompts as AutoCAD; DIVIDE range; LENGTHEN Undo', async () => {
    const { canvas, user } = await openWorkspace();
    await chooseLayer(user, 'Route');
    await type(user, 'do');
    await type(user, '');
    await type(user, '');
    expect(prompt()).toBe('DONUT Specify center of donut or <exit>:');
    await type(user, '');
    await type(user, 'el');
    await type(user, 'a');
    expect(prompt()).toBe('ELLIPSE Specify axis endpoint of elliptical arc or [Center]:');
    await user.keyboard('{Escape}');
    await type(user, 'spl');
    await type(user, '0,0');
    expect(prompt()).toBe('SPLINE Enter next point:');
    await type(user, '10,0');
    expect(prompt()).toBe('SPLINE Enter next point or [Undo]:');
    await type(user, '20,5');
    expect(prompt()).toBe('SPLINE Enter next point or [Undo/Close]:');
    await user.keyboard('{Escape}');
    await type(user, 'helix');
    await type(user, '0,0');
    await type(user, '');
    await type(user, '');
    expect(prompt()).toBe('HELIX Specify helix height or [Turns] <1.0000>:');
    await type(user, 't');
    expect(prompt()).toBe('HELIX Enter number of turns <3.0000>:');
    await type(user, '2');
    expect(prompt()).toBe('HELIX Specify helix height or [Turns] <1.0000>:');
    await type(user, '');
    expect(prompt()).toBe('Type a command');
    await type(user, 'div');
    await click(user, canvas, 75, 25);
    await type(user, '1');
    expect(history()).toMatch(/Requires an integer between 2 and 32767/);
    await user.keyboard('{Escape}');
    await type(user, 'len');
    await type(user, 'de');
    await type(user, '5');
    await click(user, canvas, 95, 25);
    await type(user, 'u');
    await type(user, '');
    await save(user);
    // Only the helix stays: the lengthened line was undone.
    expect(sent()).toEqual([expect.objectContaining({ kind: 'add_curve', layer: 'Route' })]);
  });
});
