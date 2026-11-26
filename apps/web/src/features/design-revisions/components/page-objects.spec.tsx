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
 * Owner item 36 (ADR-061): what is drawn, pasted or copied on the page is an object exactly like
 * AutoCAD, before and after «حفظ»: picked, moved, copied, trimmed, erased by its NEW- / FIX- handle.
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

describe('page items are objects (item 36)', { timeout: 20_000 }, () => {
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
  const command = () => screen.getByLabelText('Command');
  const type = async (user: User, text: string) => user.type(command(), `${text}{Enter}`);
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

  const requests = (call = 0) =>
    (
      api.createCorrections.mock.calls[call]?.[2] as {
        items: { correction: Record<string, unknown>; ref?: string }[];
      }
    ).items;

  it('a drawn line is picked, moved, copied and the copy copied; the save names them NEW-<ref>', async () => {
    const { canvas, user } = await openWorkspace();
    await chooseLayer(user, 'Route');
    await type(user, 'l');
    await type(user, '10,10');
    await type(user, '30,10');
    await type(user, '');
    // MOVE: the line just drawn is picked by a click on it.
    await type(user, 'm');
    await click(user, canvas, 20, 10);
    await type(user, '');
    await type(user, '0,0');
    await type(user, '0,5');
    await type(user, 'co');
    await click(user, canvas, 20, 15);
    await type(user, '');
    await type(user, '0,0');
    await type(user, '50,0');
    await type(user, '');
    // COPY of the copy (it is an object too).
    await type(user, 'co');
    await click(user, canvas, 70, 15);
    await type(user, '');
    await type(user, '0,0');
    await type(user, '0,-10');
    await type(user, '');
    await save(user);
    const items = requests();
    const [add, move, copy, copyOfCopy] = items;
    expect(add?.correction).toMatchObject({ kind: 'add_curve', layer: 'Route' });
    expect(add?.ref).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(move?.correction).toEqual({
      kind: 'move_item',
      handle: `NEW-${add?.ref}`,
      dx: 0,
      dy: 5,
    });
    expect(copy?.correction).toMatchObject({ kind: 'copy_item', handle: `NEW-${add?.ref}` });
    expect(copy?.ref).toBeTruthy();
    expect(copyOfCopy?.correction).toMatchObject({
      kind: 'copy_item',
      handle: `NEW-${copy?.ref}`,
      dx: 0,
      dy: -10,
    });
    expect(items).toHaveLength(4);
  });

  it('TRIM and ERASE work on lines drawn on the page before the save', async () => {
    const { canvas, user } = await openWorkspace();
    await chooseLayer(user, 'Route');
    await type(user, 'l');
    await type(user, '60,10');
    await type(user, '90,10');
    await type(user, '');
    await type(user, 'l');
    await type(user, '75,5');
    await type(user, '75,15');
    await type(user, '');
    await type(user, 'tr');
    await click(user, canvas, 85, 10);
    await type(user, '');
    await type(user, 'e');
    await click(user, canvas, 75, 13);
    await type(user, '');
    await save(user);
    const [first, second, trim, erase] = requests();
    expect(trim?.correction).toEqual({
      kind: 'set_curve',
      handle: `NEW-${first?.ref}`,
      points: [
        [60, 10],
        [75, 10],
      ],
      closed: false,
    });
    expect(erase?.correction).toEqual({ kind: 'erase_item', handle: `NEW-${second?.ref}` });
  });

  it('after the save the item is FIX-<id>: picked, erased, and its Properties shown', async () => {
    const LINE = '99999999-9999-4999-8999-999999999991';
    api.listCorrections.mockResolvedValue({
      items: [
        {
          id: LINE,
          cadFileId: FILE_ID,
          correction: {
            kind: 'add_curve',
            layer: 'Route',
            points: [
              [10, 10],
              [30, 10],
            ],
            closed: false,
          },
          problem: null,
          createdBy: null,
          createdAt: '2026-11-26T10:00:00+00:00',
          withdrawnBy: null,
          withdrawnAt: null,
        },
      ],
      activeCount: 1,
    });
    const { canvas, user } = await openWorkspace();
    await click(user, canvas, 20, 10);
    // Picked between commands: it has its grips and a handle like any object.
    await type(user, 'e');
    await save(user);
    expect(requests()[0]?.correction).toEqual({ kind: 'erase_item', handle: `FIX-${LINE}` });
  });

  it('a CIRCLE drawn sends add_curve.arc; CEN snaps a LINE to its centre', async () => {
    const { canvas, user } = await openWorkspace();
    await chooseLayer(user, 'Route');
    await type(user, 'c');
    await type(user, '60,10');
    await type(user, '5');
    await type(user, 'l');
    await type(user, 'cen');
    // The pointer on the circle: Center snaps to its centre.
    await click(user, canvas, 65, 10);
    await type(user, '80,10');
    await type(user, '');
    await save(user);
    const [circle, line] = requests();
    expect(circle?.correction).toMatchObject({
      kind: 'add_curve',
      closed: true,
      arc: { x: 60, y: 10, r: 5, start: 0, end: 360 },
    });
    expect(line?.correction).toMatchObject({
      kind: 'add_curve',
      points: [
        [60, 10],
        [80, 10],
      ],
    });
  });
});
