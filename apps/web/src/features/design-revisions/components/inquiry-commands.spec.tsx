import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DrawingViewState } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { FILE_ID, testView } from '../model/drawing-test-view';
import { createMockContext, FakePath2D } from '../model/mock-canvas';
import { fitTransform, toScreen } from '../model/view-transform';
import { angleOfLines } from '../hooks/inquiry-commands';
import { DrawingViewer } from './drawing-viewer';

/** Audit 4.2 / 11: ID, DIST, AREA, LIST and MEASUREGEOM. */

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

describe('angle of two lines (MEASUREGEOM Angle)', () => {
  it('is measured in the quadrant of the picks', () => {
    const h: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const d: typeof h = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(angleOfLines(h, { x: 5, y: 0 }, d, { x: 5, y: 5 })).toBeCloseTo(45, 9);
    expect(angleOfLines(h, { x: -5, y: 0 }, d, { x: 5, y: 5 })).toBeCloseTo(135, 9);
    expect(
      angleOfLines(
        h,
        { x: 5, y: 0 },
        [
          { x: 0, y: 1 },
          { x: 9, y: 1 },
        ],
        { x: 2, y: 1 },
      ),
    ).toBeNull();
  });
});

describe('inquiry commands typed (audit 4.2)', { timeout: 30_000 }, () => {
  it('ID prints the point; DIST the distance, angle and deltas', async () => {
    const { user } = await openWorkspace();
    await type(user, 'id');
    expect(prompt()).toBe('ID Specify point:');
    await type(user, '10,5');
    expect(history()).toContain('X = 10.0000     Y = 5.0000     Z = 0.0000');
    await type(user, 'di');
    expect(prompt()).toBe('DIST Specify first point:');
    await type(user, '0,0');
    expect(prompt()).toBe('DIST Specify second point or [Multiple points]:');
    await type(user, '10,5');
    expect(history()).toContain(
      'Distance = 11.1803,  Angle in XY Plane = 27,  Angle from XY Plane = 0',
    );
    expect(history()).toContain('Delta X = 10.0000,  Delta Y = 5.0000,  Delta Z = 0.0000');
    expect(prompt()).toBe('Type a command');
  });

  it('DIST Multiple points adds the segments; Undo takes the last one back', async () => {
    const { user } = await openWorkspace();
    await type(user, 'dist');
    await type(user, '0,0');
    await type(user, 'm');
    expect(prompt()).toBe('DIST Specify next point or [Arc/Length/Undo/Total] <Total>:');
    await type(user, '3,4');
    expect(history()).toContain('Distance = 5.0000');
    await type(user, '3,10');
    await type(user, 'u');
    await type(user, '3,0');
    await type(user, 'a');
    expect(history()).toMatch(/Arc and Length segments are not available/);
    await type(user, '');
    expect(history()).toContain('Distance = 9.0000');
  });

  it('AREA by points, then Add area and Subtract area keep a total', async () => {
    const { user } = await openWorkspace();
    await type(user, 'aa');
    expect(prompt()).toBe(
      'AREA Specify first corner point or [Object/Add area/Subtract area] <Object>:',
    );
    await type(user, '0,0');
    expect(prompt()).toBe('AREA Specify next point or [Arc/Length/Undo]:');
    await type(user, '10,0');
    expect(prompt()).toBe('AREA Specify next point or [Arc/Length/Undo/Total] <Total>:');
    await type(user, '10,5');
    await type(user, '');
    expect(history()).toContain('Area = 25.0000, Perimeter = 26.1803');
    await type(user, 'area');
    await type(user, 'a');
    expect(prompt()).toBe('AREA Specify first corner point or [Object/Subtract area/eXit]:');
    await type(user, '0,0');
    expect(prompt()).toBe('AREA (ADD mode) Specify next point or [Arc/Length/Undo]:');
    await type(user, '10,0');
    await type(user, '10,10');
    await type(user, '0,10');
    await type(user, '');
    expect(history()).toContain('Area = 100.0000, Perimeter = 40.0000');
    expect(history()).toContain('Total area = 100.0000');
    await type(user, 's');
    await type(user, '0,0');
    await type(user, '5,0');
    await type(user, '5,5');
    await type(user, '');
    expect(history()).toContain('Total area = 87.5000');
    await type(user, 'x');
    expect(prompt()).toBe('Type a command');
  });

  it('AREA Object measures a polyline (open: as closed, its own length)', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'area');
    await type(user, '');
    expect(prompt()).toBe('AREA Select objects:');
    await clickAt(user, canvas, 75, 25);
    expect(history()).toContain('Selected object does not have area.');
    await clickAt(user, canvas, 25, 0);
    expect(history()).toContain('Area = 625.0000, Length = 75.0000');
    expect(prompt()).toBe('Type a command');
  });

  it('LIST prints AutoCAD lines for the picked objects', async () => {
    const { canvas, user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Command history (F2)' }));
    await type(user, 'li');
    await clickAt(user, canvas, 75, 25);
    await type(user, '');
    const text = history();
    expect(text).toContain('LINE  Layer: "Route"');
    expect(text).toContain('Space: Model space');
    expect(text).toContain('Handle = B');
    expect(text).toContain('from point, X= 50.0000  Y= 25.0000  Z= 0.0000');
    expect(text).toContain('to point, X= 100.0000  Y= 25.0000  Z= 0.0000');
    expect(text).toContain('Length = 50.0000,  Angle in XY Plane = 0');
    await type(user, 'list');
    await clickAt(user, canvas, 25, 0);
    await type(user, '');
    expect(history()).toContain('LWPOLYLINE  Layer: "Route"');
    expect(history()).toContain('Open');
    expect(history()).toContain('length 75.0000');
  });

  it('MEASUREGEOM: Distance by default, Radius, Angle of two lines, Volume, eXit', async () => {
    const { canvas, user } = await openWorkspace();
    await type(user, 'mea');
    expect(prompt()).toBe(
      'MEASUREGEOM Enter an option [Distance/Radius/Angle/ARea/Volume/eXit] <Distance>:',
    );
    await type(user, '');
    await type(user, '0,0');
    await type(user, '3,4');
    expect(history()).toContain('Distance = 5.0000');
    expect(prompt()).toMatch(/^MEASUREGEOM Enter an option/);
    await type(user, 'r');
    expect(prompt()).toBe('MEASUREGEOM Select arc or circle:');
    await clickAt(user, canvas, 75, 25);
    expect(history()).toContain('Object selected is not an arc or circle.');
    await user.keyboard('{Escape}');
    await type(user, 'mea');
    await type(user, 'a');
    expect(prompt()).toBe('MEASUREGEOM Select arc, circle, line, or <Specify vertex>:');
    await clickAt(user, canvas, 25, 0);
    expect(prompt()).toBe('MEASUREGEOM Select second line:');
    await clickAt(user, canvas, 50, 12);
    expect(history()).toContain('Angle = 90°');
    await type(user, 'v');
    expect(history()).toMatch(/Volume needs heights/);
    await type(user, 'ar');
    await type(user, '0,0');
    await type(user, '4,0');
    await type(user, '4,3');
    await type(user, '');
    expect(history()).toContain('Area = 6.0000, Perimeter = 12.0000');
    await type(user, 'x');
    expect(prompt()).toBe('Type a command');
  });

  it("'DIST inside a command, then the command goes on", async () => {
    const { user } = await openWorkspace();
    await type(user, 'z');
    await type(user, "'di");
    await type(user, '0,0');
    await type(user, '0,7');
    expect(history()).toContain(
      'Distance = 7.0000,  Angle in XY Plane = 90,  Angle from XY Plane = 0',
    );
    expect(history()).toMatch(/Resuming ZOOM command\./);
    expect(prompt()).toMatch(/^ZOOM Specify corner of window/);
  });
});
