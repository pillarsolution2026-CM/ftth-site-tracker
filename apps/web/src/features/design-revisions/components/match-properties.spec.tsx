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
 * MATCHPROP and the ribbon's Properties panel as AutoCAD (owner 2026-11-26, item 34; round 3
 * Phase 2D): the source's own colour and layer are copied, destinations repeat (pick, window)
 * until Enter, Settings opens the Property Settings dialog, and with nothing picked the panel sets
 * the current properties.
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

describe('MATCHPROP, the Properties panel and layers (Phase 2D)', { timeout: 20_000 }, () => {
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
  const drag = async (user: User, canvas: Element, from: [number, number], to: [number, number]) =>
    user.pointer([
      { keys: '[MouseLeft>]', target: canvas, coords: at(...from) },
      { target: canvas, coords: at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2) },
      { target: canvas, coords: at(...to) },
      { keys: '[/MouseLeft]' },
    ]);

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

  it('copies the own colour of the source and its layer; destinations repeat until Enter', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'ma');
    expect(prompt()).toMatch(/Select source object:/);
    // B: a line with its own colour in the file (not a style), on Route.
    await click(user, canvas, 75, 25);
    expect(history()).toMatch(
      /Current active settings: Color Layer Ltype Ltscale Lineweight Transparency Thickness PlotStyle Dim Text Hatch Polyline Viewport Table Material Multileader Center object/,
    );
    expect(prompt()).toMatch(/Select destination object\(s\) or \[Settings\]:/);
    // T1: a text on Sap — it takes B's colour and moves to Route.
    await click(user, canvas, 31, 31);
    expect(prompt()).toMatch(/Select destination object\(s\) or \[Settings\]:/);
    await click(user, canvas, 25, 0);
    await type(user, '');
    expect(prompt()).toMatch(/Type a command/);
    await save(user);
    expect(sent()).toEqual([
      { kind: 'set_style', handle: 'T1', color: '#123456', linetype: null, lineweight: null },
      { kind: 'move_layer', handle: 'T1', toLayer: 'Route' },
      { kind: 'set_style', handle: 'A', color: '#123456', linetype: null, lineweight: null },
    ]);
  });

  it('takes destinations by a crossing window and the object picked first as the source', async () => {
    const { canvas, user } = await openWorkspace();
    await click(user, canvas, 75, 25);
    await type(user, 'ma');
    expect(prompt()).toMatch(/Select destination object\(s\) or \[Settings\]:/);
    // A crossing window (dragged right to left) over the corner of the polyline A only.
    await drag(user, canvas, [52, 10], [45, -2]);
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([
      { kind: 'set_style', handle: 'A', color: '#123456', linetype: null, lineweight: null },
    ]);
  });

  it('Settings opens the Property Settings dialog; what is turned off is not copied', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'ma');
    await click(user, canvas, 75, 25);
    await type(user, 's');
    const dialog = screen.getByRole('dialog', { name: 'Property Settings' });
    expect(within(dialog).getByRole('checkbox', { name: 'Thickness' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Layer' }));
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog', { name: 'Property Settings' })).not.toBeInTheDocument();
    expect(history()).toMatch(/Current active settings: Color Ltype/);
    expect(prompt()).toMatch(/Select destination object\(s\) or \[Settings\]:/);
    await click(user, canvas, 31, 31);
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([
      { kind: 'set_style', handle: 'T1', color: '#123456', linetype: null, lineweight: null },
    ]);
  });

  it('copies the text height to a text (scaled about its insertion point)', async () => {
    api.getDrawingView.mockResolvedValue(
      testView({
        entities: [
          ...testView().entities,
          {
            handle: 'T2',
            layer: 1,
            color: null,
            kind: 'TEXT',
            paths: [],
            texts: [{ x: 60, y: 40, height: 5, rotation: 0, text: 'BIG' }],
          },
        ],
      }),
    );
    const { canvas, user } = await openWorkspace();
    await type(user, 'ma');
    await click(user, canvas, 61, 41);
    await click(user, canvas, 31, 31);
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([{ kind: 'scale_item', handle: 'T1', x: 30, y: 30, factor: 2 }]);
  });

  it('with nothing picked the panel sets the current properties, with swatches and dialogs', async () => {
    const { canvas, user } = await openWorkspace();
    const color = () => screen.getByLabelText('Color');
    await user.click(color());
    const list = screen.getByRole('listbox', { name: 'Color' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'ByLayer',
      'ByBlock',
      'Red',
      'Yellow',
      'Green',
      'Cyan',
      'Blue',
      'Magenta',
      'White',
      'More Colors...',
    ]);
    expect(within(list).getByRole('option', { name: 'ByBlock' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(within(list).getByRole('option', { name: 'Red' }));
    expect(color()).toHaveTextContent('Red');
    // A picked object shows its own colour; with nothing picked again the current one comes back.
    await click(user, canvas, 75, 25);
    expect(color()).toHaveTextContent('18,52,86');
    await user.keyboard('{Escape}');
    expect(color()).toHaveTextContent('Red');
    // More Colors…: the Select Color dialog with the 255 index colours.
    await user.click(color());
    await user.click(screen.getByRole('option', { name: 'More Colors...' }));
    const dialog = screen.getByRole('dialog', { name: 'Select Color' });
    await user.click(within(dialog).getByRole('button', { name: 'Index color: 30' }));
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(color()).toHaveTextContent('Color 30');
    // Linetype Other…: the Linetype Manager; Current then OK sets the current line type.
    await user.click(screen.getByLabelText('Linetype'));
    await user.click(screen.getByRole('option', { name: 'Other...' }));
    const manager = screen.getByRole('dialog', { name: 'Linetype Manager' });
    expect(within(manager).getByRole('button', { name: 'Load...' })).toBeDisabled();
    await user.click(within(manager).getByRole('button', { name: 'CENTER' }));
    await user.click(within(manager).getByRole('button', { name: 'Current' }));
    expect(within(manager).getByText('Current Linetype: CENTER')).toBeInTheDocument();
    await user.click(within(manager).getByRole('button', { name: 'OK' }));
    expect(screen.getByLabelText('Linetype')).toHaveTextContent('CENTER');
    await user.click(screen.getByLabelText('Lineweight'));
    expect(screen.getByRole('option', { name: 'Default' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('option', { name: '0.30 mm' }));
    expect(screen.getByLabelText('Lineweight')).toHaveTextContent('0.30 mm');
    // Nothing was changed on the drawing.
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  });

  it('with objects picked the drop-downs change them, More Colors too', async () => {
    const { canvas, user } = await openWorkspace();
    await click(user, canvas, 25, 0);
    await user.click(screen.getByLabelText('Color'));
    await user.click(screen.getByRole('option', { name: 'More Colors...' }));
    const dialog = screen.getByRole('dialog', { name: 'Select Color' });
    await user.click(within(dialog).getByRole('tab', { name: 'True Color' }));
    const rgb = within(dialog).getByLabelText('Color (r,g,b or #rrggbb)');
    await user.clear(rgb);
    await user.type(rgb, '10,20,30');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    await user.click(screen.getByLabelText('Lineweight'));
    await user.click(screen.getByRole('option', { name: '0.50 mm' }));
    await save(user);
    expect(sent()).toEqual([
      { kind: 'set_style', handle: 'A', color: '#0a141e', linetype: null, lineweight: 0.5 },
    ]);
  });

  it('the Properties palette with nothing picked shows and sets the current properties', async () => {
    const { user } = await openWorkspace();
    await user.keyboard('{Control>}1{/Control}');
    const palette = screen.getByRole('complementary', { name: 'Properties' });
    expect(within(palette).getByText('No selection')).toBeInTheDocument();
    await user.selectOptions(within(palette).getByLabelText('Color'), 'Blue');
    const ribbonColor = screen.getAllByLabelText('Color').find((el) => el.tagName === 'BUTTON');
    expect(ribbonColor).toHaveTextContent('Blue');
  });

  it('the current layer cannot be frozen (AutoCAD); page layers get their own screen state', async () => {
    const { canvas, user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: /^Layer: / }));
    const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
    await user.click(within(list).getByRole('button', { name: 'Route' }));
    await type(user, 'layfrz');
    await click(user, canvas, 75, 25);
    expect(history()).toMatch(/Cannot freeze layer "Route"\.\s+It is the CURRENT layer\./);
    await user.keyboard('{Escape}');
    await type(user, 'la');
    const manager = screen.getByRole('dialog', { name: 'Layer Properties Manager' });
    await user.click(within(manager).getByRole('button', { name: 'Freeze Route' }));
    expect(within(manager).getByRole('alert')).toHaveTextContent(
      /Cannot freeze layer "Route"\.\s+It is the CURRENT layer\./,
    );
    expect(within(manager).getByRole('button', { name: 'Freeze Route' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // A layer made on the page has on / freeze / lock like the drawing's layers.
    await user.click(within(manager).getByRole('button', { name: 'New layer' }));
    const form = within(manager).getByRole('group', { name: 'New layer' });
    await user.type(within(form).getByLabelText('Layer name'), 'HOUSES');
    await user.selectOptions(
      within(form).getByLabelText('Means for the build'),
      'Drawing only (not counted)',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the layer' }));
    // HOUSES is current now: it cannot be frozen, Route can.
    await user.click(within(manager).getByRole('button', { name: 'Freeze HOUSES' }));
    expect(within(manager).getByRole('alert')).toHaveTextContent(/Cannot freeze layer "HOUSES"/);
    await user.click(within(manager).getByRole('button', { name: 'Freeze Route' }));
    expect(within(manager).getByRole('button', { name: 'Freeze Route' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(manager).getByRole('button', { name: 'Lock HOUSES' }));
    expect(within(manager).getByRole('button', { name: 'Lock HOUSES' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
