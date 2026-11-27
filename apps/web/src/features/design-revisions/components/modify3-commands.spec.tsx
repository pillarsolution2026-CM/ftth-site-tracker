import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { DrawingViewer } from './drawing-viewer';

/** Audit 4.2 (round 3): ARRAYPOLAR, ARRAYPATH and CHAMFER as AutoCAD. */

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

describe('ARRAYPOLAR / ARRAYPATH / CHAMFER (audit 4.2)', { timeout: 60_000 }, () => {
  it('ARRAYPOLAR: centre, Items, Enter makes turned copies around the centre', async () => {
    const { canvas, user } = await openWorkspace();
    await clickAt(user, canvas, 75, 25);
    await type(user, 'arraypolar');
    expect(history()).toContain('Type = Polar  Associative = No');
    expect(prompt()).toBe(
      'ARRAYPOLAR Specify center point of array or [Base point/Axis of rotation]:',
    );
    await type(user, '50,25');
    expect(prompt()).toBe(
      'ARRAYPOLAR Select grip to edit array or [ASsociative/Base point/Items/Angle between/Fill angle/ROWs/Levels/ROTate items/eXit] <eXit>:',
    );
    await type(user, 'i');
    expect(prompt()).toBe('ARRAYPOLAR Enter number of items in array or [Expression] <6>:');
    await type(user, '4');
    await type(user, '');
    expect(prompt()).toBe('Type a command');
    await save(user);
    const edits = sent();
    expect(edits.filter((e) => e.kind === 'copy_item')).toHaveLength(3);
    expect(edits.filter((e) => e.kind === 'rotate_item').map((e) => e.angle)).toEqual([
      90, 180, -90,
    ]);
    for (const e of edits.filter((e) => e.kind === 'rotate_item')) {
      expect(e).toMatchObject({ x: 50, y: 25 });
      expect(e.handle).toMatch(/^NEW-/);
    }
  });

  it('ARRAYPATH: the copies go along the path and turn with it', async () => {
    const { canvas, user } = await openWorkspace();
    await clickAt(user, canvas, 75, 25);
    await type(user, 'arraypath');
    expect(prompt()).toBe('ARRAYPATH Select path curve:');
    await clickAt(user, canvas, 25, 0);
    expect(prompt()).toMatch(/^ARRAYPATH Select grip to edit array or \[ASsociative\/Method/);
    await type(user, '');
    await save(user);
    expect(sent()).toEqual([
      { kind: 'copy_item', handle: 'B', dx: 50, dy: 25, toLayer: null },
      expect.objectContaining({ kind: 'rotate_item', x: 50, y: 25, angle: 90 }),
    ]);
  });

  it('CHAMFER: Distance, then two lines are cut back and joined by the chamfer line', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'cha');
    expect(history()).toContain('(TRIM mode) Current chamfer Dist1 = 0.0000, Dist2 = 0.0000');
    expect(prompt()).toBe(
      'CHAMFER Select first line or [Undo/Polyline/Distance/Angle/Trim/mEthod/Multiple]:',
    );
    await type(user, 'd');
    expect(prompt()).toBe('CHAMFER Specify first chamfer distance <0.0000>:');
    await type(user, '5');
    expect(prompt()).toBe('CHAMFER Specify second chamfer distance <5.0000>:');
    await type(user, '');
    await clickAt(user, canvas, 50, 10);
    expect(prompt()).toBe(
      'CHAMFER Select second line or shift-select to apply corner or [Distance/Angle/Method]:',
    );
    await clickAt(user, canvas, 75, 25);
    expect(prompt()).toBe('Type a command');
    await save(user);
    expect(sent()).toEqual([
      {
        kind: 'set_curve',
        handle: 'A',
        points: [
          [0, 0],
          [50, 0],
          [50, 20],
        ],
        closed: false,
      },
      {
        kind: 'set_curve',
        handle: 'B',
        points: [
          [55, 25],
          [100, 25],
        ],
        closed: false,
      },
      expect.objectContaining({
        kind: 'add_curve',
        points: [
          [50, 20],
          [55, 25],
        ],
      }),
    ]);
  });
});
