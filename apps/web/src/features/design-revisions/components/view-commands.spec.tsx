import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { DrawingViewer } from './drawing-viewer';

/** Audit 4.1 / 4.2: ZOOM, PAN, REGEN, U, UNDO, REDO, OOPS and transparent commands. */

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
/** The drawing point under a screen point (the canvas is 800 × 600). */
async function worldAt(user: User, canvas: Element, sx: number, sy: number) {
  await user.pointer({ target: canvas, coords: { clientX: sx, clientY: sy + 1 } });
  await user.pointer({ target: canvas, coords: { clientX: sx, clientY: sy } });
  const text = screen.getByTestId('drawing-coords').textContent ?? '';
  const m = /X (-?\d+\.\d+)\s+Y (-?\d+\.\d+)/.exec(text);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
/** How many edits are not saved yet. */
const pending = () =>
  Number(
    /(\d+)\D{0,3}edits not saved yet/.exec(
      screen.getByTestId('cad-command-line').textContent ?? '',
    )?.[1] ?? 0,
  );
/** A command on every shown object («Select objects: all»). */
async function onAll(user: User, name: string, ...then: string[]) {
  await type(user, name);
  await type(user, 'all');
  await type(user, '');
  for (const entry of then) await type(user, entry);
}

describe('ZOOM, PAN and REGEN typed (audit 4.2)', { timeout: 30_000 }, () => {
  it('ZOOM asks as AutoCAD; Window, nX, Previous and Extents', async () => {
    const { canvas, user } = await openWorkspace();
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 50, y: 25 });
    await type(user, 'z');
    expect(prompt()).toBe(
      'ZOOM Specify corner of window, enter a scale factor (nX or nXP), or [All/Center/Dynamic/Extents/Previous/Scale/Window/Object] <real time>:',
    );
    await type(user, '0,0');
    expect(prompt()).toBe('ZOOM Specify opposite corner:');
    await type(user, '20,20');
    expect(prompt()).toBe('Type a command');
    // The window fills the canvas' height: 20 units over 600 px.
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 10, y: 10 });
    expect(await worldAt(user, canvas, 400, 0)).toEqual({ x: 10, y: 20 });
    await type(user, 'zoom');
    await type(user, '2x');
    expect(await worldAt(user, canvas, 400, 0)).toEqual({ x: 10, y: 15 });
    await type(user, 'z');
    await type(user, 'p');
    expect(await worldAt(user, canvas, 400, 0)).toEqual({ x: 10, y: 20 });
    await type(user, 'z');
    await type(user, 'e');
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 50, y: 25 });
    await type(user, 'z');
    await type(user, 'p');
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 10, y: 10 });
  });

  it('ZOOM Center, Scale, Dynamic, nXP, real time and no previous view', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'z');
    await type(user, 'c');
    expect(prompt()).toBe('ZOOM Specify center point:');
    await type(user, '30,30');
    expect(prompt()).toMatch(/^ZOOM Enter magnification or height <\d+\.\d{4}>:$/);
    await type(user, '6');
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 30, y: 30 });
    expect(await worldAt(user, canvas, 400, 0)).toEqual({ x: 30, y: 33 });
    await type(user, 'z');
    await type(user, 'd');
    expect(history()).toMatch(/ZOOM Dynamic needs AutoCAD's view box/);
    expect(prompt()).toMatch(/^ZOOM Specify corner of window/);
    await type(user, '2xp');
    expect(history()).toMatch(/model space only/);
    await type(user, 'q');
    expect(history()).toMatch(/Requires a distance, numberX, or option keyword\./);
    await type(user, 's');
    expect(prompt()).toBe('ZOOM Enter a scale factor (nX or nXP):');
    await type(user, '0.5x');
    expect(await worldAt(user, canvas, 400, 0)).toEqual({ x: 30, y: 36 });
    await type(user, 'z');
    await type(user, '');
    expect(history()).toMatch(/Real time: zoom with the mouse wheel/);
    expect(prompt()).toBe('Type a command');
    for (let i = 0; i < 3; i++) {
      await type(user, 'z');
      await type(user, 'p');
    }
    expect(history()).toMatch(/No previous view saved\./);
  });

  it('ZOOM Object zooms to the picked objects', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'z');
    await type(user, 'w');
    await type(user, '0,0');
    await type(user, '10,10');
    await type(user, 'z');
    await type(user, 'o');
    expect(prompt()).toBe('ZOOM Select objects:');
    await type(user, 'all');
    await type(user, '');
    // Everything shown, 0 to 100 across (the hidden layer is not picked), fitted to the width.
    expect((await worldAt(user, canvas, 400, 300))?.x).toBe(50);
    expect((await worldAt(user, canvas, 0, 300))?.x).toBe(0);
  });

  it('PAN moves the drawing by the displacement; REGEN regenerates', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'p');
    expect(prompt()).toBe('PAN Specify base point or displacement:');
    await type(user, '0,0');
    expect(prompt()).toBe('PAN Specify second point:');
    await type(user, '10,5');
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 40, y: 20 });
    await type(user, 're');
    expect(history()).toMatch(/Regenerating model\./);
  });

  it("'ZOOM inside LINE: «>>» prompts, then «Resuming LINE command.»", async () => {
    const { canvas, user } = await openWorkspace();
    await chooseRoute(user);
    await type(user, 'l');
    await type(user, '0,0');
    await type(user, "'z");
    expect(prompt()).toMatch(/^>> Specify corner of window/);
    await type(user, 'w');
    await type(user, '0,0');
    await type(user, '20,20');
    expect(history()).toMatch(/Resuming LINE command\./);
    expect(prompt()).toBe('LINE Specify next point or [Undo]:');
    expect(await worldAt(user, canvas, 400, 300)).toEqual({ x: 10, y: 10 });
    await type(user, "'p");
    await type(user, '0,0');
    await type(user, '-10,0');
    expect(prompt()).toBe('LINE Specify next point or [Undo]:');
    await type(user, "'erase");
    expect(history()).toMatch(/That command may not be invoked transparently/);
    await type(user, '10,0');
    await type(user, '');
    expect(pending()).toBe(1);
  });
});

async function chooseRoute(user: User) {
  await user.click(screen.getByRole('button', { name: /^Layer: / }));
  const list = screen.getByRole('dialog', { name: 'Layers of the drawing' });
  await user.click(within(list).getByRole('button', { name: 'Route' }));
}

describe('U, UNDO, REDO and OOPS typed (audit 4.1)', { timeout: 30_000 }, () => {
  it('U takes back the last command, REDO brings it back', async () => {
    const { user } = await openWorkspace();
    await onAll(user, 'e');
    expect(pending()).toBe(4);
    await type(user, 'u');
    expect(history()).toMatch(/ERASE/);
    expect(pending()).toBe(0);
    await type(user, 'redo');
    expect(pending()).toBe(4);
    await type(user, 'u');
    await type(user, 'u');
    expect(history()).toMatch(/Everything has been undone\./);
    await type(user, 'redo');
    await type(user, 'redo');
    expect(history()).toMatch(/Nothing to redo\./);
  });

  it('UNDO: settings line, number, Mark and Back, the options this screen has not', async () => {
    const { user } = await openWorkspace();
    await type(user, 'undo');
    expect(history()).toMatch(
      /Current settings: Auto = On, Control = All, Combine = Yes, Layer = Yes/,
    );
    expect(prompt()).toBe(
      'UNDO Enter the number of operations to undo or [Auto/Control/BEgin/End/Mark/Back] <1>:',
    );
    await type(user, 'be');
    expect(history()).toMatch(/UNDO BEgin is not available on this screen/);
    await type(user, 'm');
    expect(prompt()).toBe('Type a command');
    await onAll(user, 'e');
    await type(user, 'undo');
    await type(user, 'b');
    expect(history()).toMatch(/Mark encountered/);
    expect(pending()).toBe(0);
    await type(user, 'undo');
    await type(user, 'b');
    expect(prompt()).toBe('UNDO This will undo everything. OK? [Yes/No] <Y>:');
    await type(user, 'n');
    expect(prompt()).toBe('Type a command');
  });

  it('UNDO n takes back n commands', async () => {
    const { user } = await openWorkspace();
    await onAll(user, 'm', '0,0', '1,0');
    await onAll(user, 'm', '0,0', '1,0');
    expect(pending()).toBeGreaterThan(0);
    await type(user, 'undo');
    await type(user, '2');
    expect(history()).toMatch(/MOVE[\s\S]*MOVE/);
    expect(pending()).toBe(0);
  });

  it('OOPS brings back what the last ERASE erased, nothing else', async () => {
    const { user } = await openWorkspace();
    await type(user, 'oops');
    expect(history()).toMatch(/No erased objects to restore\./);
    await onAll(user, 'm', '0,0', '1,0');
    const moved = pending();
    await onAll(user, 'e');
    expect(pending()).toBe(moved + 4);
    await type(user, 'oops');
    expect(pending()).toBe(moved);
    await type(user, 'oops');
    expect(history()).toMatch(/No erased objects to restore\./);
    await type(user, 'u');
    expect(pending()).toBe(moved + 4);
  });
});
