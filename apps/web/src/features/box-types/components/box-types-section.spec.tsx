import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoxTypeState, BoxTypesReport, WorkOrderDetail } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { BoxTypesSection } from './box-types-section';

const api = vi.hoisted(() => ({
  getBoxTypeState: vi.fn(),
  setBoxTypes: vi.fn(),
  getBoxTypesReport: vi.fn(),
}));
vi.mock('../api/box-types-api', () => api);
const orders = vi.hoisted(() => ({ listWorkOrders: vi.fn(), getWorkOrder: vi.fn() }));
vi.mock('@/features/work-orders/api/work-orders-api', () => orders);

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REVISION = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const ORDER = '1f8fad5b-d9cb-469f-a165-70867728950e';
const LINE_1 = '11111111-1111-4111-8111-111111111111';
const LINE_2 = '22222222-2222-4222-8222-222222222223';
const A = `v1-${'a'.repeat(64)}`;
const B = `v1-${'b'.repeat(64)}`;
const USER = { id: '44444444-4444-4444-8444-444444444444', name: 'Mona' };

function report(overrides: Partial<BoxTypesReport> = {}): BoxTypesReport {
  return {
    applies: true,
    gallery: {
      version: 1,
      boxCount: 12,
      shapeCount: 2,
      boxesWithoutShape: 0,
      shapes: [
        {
          shape: A,
          source: 'block',
          count: 10,
          blockNames: ['box c', 'box d'],
          sampleHandles: ['B1', 'B2'],
          preview: {
            paths: [[-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5]],
            texts: [{ x: 0, y: 0, height: 0.2, rotation: 0, text: '8' }],
            truncated: false,
          },
        },
        {
          shape: B,
          source: 'block',
          count: 2,
          blockNames: ['box e'],
          sampleHandles: ['B9'],
          preview: null,
        },
      ],
    },
    frozen: null,
    ok: false,
    issueCount: 2,
    issues: [
      { code: 'BOX_TYPE_UNSET', shape: A, boxCount: 10, workOrderLineId: null },
      { code: 'BOX_TYPE_UNSET', shape: B, boxCount: 2, workOrderLineId: null },
    ],
    totals: null,
    changedSinceBuild: false,
    ...overrides,
  };
}

function live(
  active: Record<string, string> = {},
  previous: Record<string, string> | null = null,
): BoxTypeState {
  return {
    cadFileId: FILE,
    drawingKind: 'secondary',
    applies: true,
    active: Object.entries(active).map(([shape, line], index) => ({
      id: `55555555-5555-4555-8555-55555555555${index}`,
      cadFileId: FILE,
      shape,
      workOrderLineId: line,
      createdBy: USER,
      createdAt: '2026-11-12T10:00:00.000Z',
    })),
    history: [],
    previousVersion: previous
      ? {
          cadFileId: FILE,
          choices: Object.entries(previous).map(([shape, line]) => ({
            shape,
            workOrderLineId: line,
          })),
        }
      : null,
  };
}

function detail(): WorkOrderDetail {
  const item = (id: string, lineNo: number, code: string, description: string) => ({
    id,
    workOrderId: ORDER,
    lineNo,
    code,
    description,
    unit: 'pc',
    quantity: '10',
    unitPrice: '100',
    amount: '1000',
    workType: 'installation',
    contractItemId: null,
    source: 'manual',
    sourceRow: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  return {
    id: ORDER,
    projectId: PROJECT,
    number: 'WO-1',
    title: null,
    issuedOn: null,
    currency: 'EGP',
    source: 'manual',
    itemCount: 2,
    total: '2000',
    attachmentCount: 0,
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    notes: null,
    items: [
      item(LINE_1, 1, 'BX-8', 'Box 8 ways with splitter 4'),
      item(LINE_2, 2, 'BX-4', 'Box 4 ways with splitter 4'),
    ],
    attachments: [],
    duplicateCodes: [],
  } as unknown as WorkOrderDetail;
}

function renderSection(props: { canEdit?: boolean; onShowHandle?: (h: string) => void } = {}) {
  renderScreen(
    <BoxTypesSection
      projectId={PROJECT}
      revisionId={REVISION}
      cadFileId={FILE}
      enabled
      canEdit={props.canEdit ?? true}
      {...(props.onShowHandle ? { onShowHandle: props.onShowHandle } : {})}
    />,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  Object.values(orders).forEach((fn) => fn.mockReset());
  api.getBoxTypesReport.mockResolvedValue(report());
  api.getBoxTypeState.mockResolvedValue(live());
  orders.listWorkOrders.mockResolvedValue({ items: [{ id: ORDER }] });
  orders.getWorkOrder.mockResolvedValue(detail());
});

describe('BoxTypesSection (ADR-043)', () => {
  it('shows a card per shape with a picture, the count, the block names and the picker', async () => {
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Box types' })).toBeInTheDocument();
    expect(screen.getByText(/12.* boxes in .*2.* different shapes/)).toBeInTheDocument();
    const cards = screen.getAllByRole('listitem').filter((li) => li.id.startsWith('box-shape-'));
    expect(cards).toHaveLength(2);
    const first = within(cards[0] as HTMLElement);
    // The picture is SVG elements (polyline, text), never injected markup.
    const picture = first.getByRole('img', { name: /Shape/ });
    expect(picture.querySelector('polyline')).not.toBeNull();
    expect(picture.querySelector('text')?.textContent).toBe('8');
    expect(first.getByText('box c')).toBeInTheDocument();
    expect(first.getByText('box d')).toBeInTheDocument();
    expect(first.getByText(/Boxes:/)).toHaveTextContent('10');
    const picker = await first.findByRole('combobox', { name: 'Choose a work-order line' });
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    expect(within(picker).getByRole('option', { name: /BX-8.*Box 8 ways/ })).toBeInTheDocument();
    expect(first.getByText('No line')).toBeInTheDocument();
  });

  it('zooms to a sample box', async () => {
    const onShowHandle = vi.fn();
    renderSection({ onShowHandle });
    const cards = (await screen.findAllByRole('listitem')).filter((li) =>
      li.id.startsWith('box-shape-'),
    );
    await userEvent.click(
      within(cards[1] as HTMLElement).getByRole('button', { name: 'Show on the drawing' }),
    );
    expect(onShowHandle).toHaveBeenCalledWith('B9');
  });

  it('saves only the shapes that changed, in one batch', async () => {
    const user = userEvent.setup();
    api.getBoxTypeState.mockResolvedValue(live({ [B]: LINE_2 }));
    api.setBoxTypes.mockResolvedValue(live({ [A]: LINE_1, [B]: LINE_2 }));
    renderSection();
    const pickers = await screen.findAllByRole('combobox', { name: 'Choose a work-order line' });
    await waitFor(() =>
      expect(within(pickers[0] as HTMLElement).getAllByRole('option')).toHaveLength(3),
    );
    const save = screen.getByRole('button', { name: 'Save choices' });
    expect(save).toBeDisabled();
    await user.selectOptions(pickers[0] as HTMLElement, LINE_1);
    expect(screen.getByText(/1.* choices not saved yet/)).toBeInTheDocument();
    await user.click(save);
    await waitFor(() =>
      expect(api.setBoxTypes).toHaveBeenCalledWith(PROJECT, FILE, {
        choices: [{ shape: A, workOrderLineId: LINE_1 }],
        fromPreviousVersion: false,
      }),
    );
  });

  it('clears a shape with an empty pick', async () => {
    const user = userEvent.setup();
    api.getBoxTypeState.mockResolvedValue(live({ [B]: LINE_2 }));
    api.setBoxTypes.mockResolvedValue(live());
    renderSection();
    const pickers = await screen.findAllByRole('combobox', { name: 'Choose a work-order line' });
    await waitFor(() => expect(pickers[1]).toHaveValue(LINE_2));
    await user.selectOptions(pickers[1] as HTMLElement, '');
    await user.click(screen.getByRole('button', { name: 'Save choices' }));
    await waitFor(() =>
      expect(api.setBoxTypes).toHaveBeenCalledWith(PROJECT, FILE, {
        choices: [{ shape: B, workOrderLineId: null }],
        fromPreviousVersion: false,
      }),
    );
  });

  it('offers the previous version’s choices and sends them as such', async () => {
    const user = userEvent.setup();
    api.getBoxTypeState.mockResolvedValue(live({}, { [A]: LINE_1 }));
    api.setBoxTypes.mockResolvedValue(live({ [A]: LINE_1 }));
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Use the previous version’s choices' }),
    );
    await waitFor(() =>
      expect(api.setBoxTypes).toHaveBeenCalledWith(PROJECT, FILE, {
        choices: [{ shape: A, workOrderLineId: LINE_1 }],
        fromPreviousVersion: true,
      }),
    );
  });

  it('says to rebuild when the choices changed since the build', async () => {
    api.getBoxTypesReport.mockResolvedValue(report({ changedSinceBuild: true }));
    renderSection();
    expect(await screen.findByText('Rebuild so the types are applied')).toBeInTheDocument();
  });

  it('lists the issues with «Choose the line» and hides editing for a reader', async () => {
    renderSection({ canEdit: false });
    expect(await screen.findAllByText(/has no work-order line/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Choose the line' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Save choices' })).not.toBeInTheDocument();
    expect(screen.getByText(/You can see the types only/)).toBeInTheDocument();
    const picker = screen.getAllByRole('combobox', { name: 'Choose a work-order line' })[0];
    expect(picker).toBeDisabled();
  });

  it('shows the all-clear when the report has no issues', async () => {
    api.getBoxTypesReport.mockResolvedValue(report({ ok: true, issueCount: 0, issues: [] }));
    renderSection();
    expect(await screen.findByText('Every box shape has a work-order line.')).toBeInTheDocument();
  });

  it('explains a missing work order and an unread gallery', async () => {
    orders.listWorkOrders.mockResolvedValue({ items: [] });
    api.getBoxTypesReport.mockResolvedValue(
      report({
        gallery: null,
        issueCount: 2,
        issues: [
          { code: 'WORK_ORDER_MISSING', shape: null, boxCount: null, workOrderLineId: null },
          { code: 'BOX_SHAPES_NOT_READ', shape: null, boxCount: null, workOrderLineId: null },
        ],
      }),
    );
    renderSection();
    expect((await screen.findAllByText(/The project has no work order/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/box shapes were not read yet/).length).toBeGreaterThan(0);
  });

  it('shows a refusal in its own words', async () => {
    const user = userEvent.setup();
    api.setBoxTypes.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'FILE_SUPERSEDED' }),
    );
    renderSection();
    const pickers = await screen.findAllByRole('combobox', { name: 'Choose a work-order line' });
    await waitFor(() =>
      expect(within(pickers[0] as HTMLElement).getAllByRole('option')).toHaveLength(3),
    );
    await user.selectOptions(pickers[0] as HTMLElement, LINE_1);
    await user.click(screen.getByRole('button', { name: 'Save choices' }));
    expect(await screen.findByText(/A newer version of the Secondary exists/)).toBeInTheDocument();
  });

  it('renders nothing for a General', async () => {
    api.getBoxTypesReport.mockResolvedValue(
      report({ applies: false, gallery: null, ok: true, issueCount: 0, issues: [] }),
    );
    renderSection();
    await waitFor(() => expect(api.getBoxTypesReport).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Box types' })).not.toBeInTheDocument();
  });
});
