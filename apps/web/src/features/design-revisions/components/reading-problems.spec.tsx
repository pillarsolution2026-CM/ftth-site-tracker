import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DrawingProblemCode,
  DrawingProblemItem,
  DrawingProblemList,
  DrawingProblemView,
} from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ProblemsSection } from './problems-section';

const api = vi.hoisted(() => ({
  listDrawingProblems: vi.fn(),
  listCorrections: vi.fn(),
  createCorrection: vi.fn(),
}));
vi.mock('../api/design-revisions-api', () => api);
const mappingApi = vi.hoisted(() => ({ getMapping: vi.fn() }));
vi.mock('@/features/cad-mapping/api/mapping-api', () => mappingApi);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

const place: DrawingProblemItem = {
  x: 1,
  y: 2,
  drawingX: 10,
  drawingY: 20,
  layer: 'TXT',
  handle: 'T1',
  suggestedLayer: null,
  text: null,
  near: null,
};

function view(code: DrawingProblemCode, items: Array<Partial<DrawingProblemItem>>) {
  return {
    code,
    severity: 'error',
    count: items.length,
    items: items.map((item) => ({ ...place, ...item })),
  } satisfies DrawingProblemView;
}

function list(
  problems: DrawingProblemView[],
  total: number,
  warningTotal: number,
): DrawingProblemList {
  return { items: problems, total, warningTotal };
}

function mappingView() {
  return {
    cadFileId: FILE,
    layers: [{ name: 'TXT' }, { name: 'HH' }, { name: 'Notes' }],
    mapping: {
      metresPerUnit: '1',
      version: 3,
      rules: [
        { source: 'layer', layer: 'HH', target: 'hhi' },
        { source: 'layer', layer: 'Notes', target: 'label' },
      ],
    },
  };
}

function render(canFix = false) {
  renderScreen(
    <ProblemsSection
      projectId={PROJECT}
      revisionId={REVISION}
      cadFileId={FILE}
      enabled
      canFix={canFix}
    />,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  mappingApi.getMapping.mockReset();
  api.listCorrections.mockResolvedValue({ items: [], activeCount: 0 });
  api.createCorrection.mockResolvedValue({});
  mappingApi.getMapping.mockResolvedValue(mappingView());
});

describe('warnings apart from errors (ADR-041)', () => {
  const data = () =>
    list(
      [
        view('CABINET_BOX_COUNT_MISMATCH', [
          { handle: 'C1', params: { cabinet: '1-3', expected: '22', found: '21' } },
        ]),
        view('CABLE_SLACK_TOO_LONG', [
          {
            handle: 'K1',
            params: { cableLengthM: '540.000', bundleLengthM: '500.000', slackM: '40.000' },
          },
        ]),
      ],
      1,
      1,
    );

  it('counts blocking places only in the heading and lists warnings under their own heading', async () => {
    api.listDrawingProblems.mockResolvedValue(data());
    render();
    expect(
      await screen.findByRole('heading', { level: 2, name: /Drawing errors: .*1/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Warnings: .*1/ })).toBeInTheDocument();
    // The note says it does not block, once under the heading and once on the problem itself.
    expect(screen.getAllByText('Warning — does not block publishing')).toHaveLength(2);
  });

  it('puts the warning problem after the warnings heading, not among the errors', async () => {
    api.listDrawingProblems.mockResolvedValue(data());
    render();
    const warnings = await screen.findByRole('heading', { level: 3, name: /Warnings/ });
    const errorBlock = screen.getByRole('heading', { level: 3, name: /Box count differs/ });
    const slack = screen.getByRole('heading', { level: 3, name: /Cable spare over 30 m/ });
    expect(
      errorBlock.compareDocumentPosition(warnings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(warnings.compareDocumentPosition(slack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says there are no errors when only warnings are left', async () => {
    api.listDrawingProblems.mockResolvedValue(
      list([view('CABLE_SLACK_TOO_LONG', [{ handle: 'K1' }])], 0, 1),
    );
    render();
    expect(await screen.findByText('No drawing errors found.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Warnings: .*1/ })).toBeInTheDocument();
  });

  it('has no warnings heading when there are none', async () => {
    api.listDrawingProblems.mockResolvedValue(
      list([view('BOX_NOT_REACHED', [{ handle: 'B1' }])], 1, 0),
    );
    render();
    await screen.findByRole('table');
    expect(screen.queryByRole('heading', { name: /Warnings/ })).not.toBeInTheDocument();
  });
});

describe('what is wrong at each place (params)', () => {
  it('names the written and the drawn box count, the slack in metres and the duplicate number', async () => {
    api.listDrawingProblems.mockResolvedValue(
      list(
        [
          view('CABINET_BOX_COUNT_MISMATCH', [
            { handle: 'C1', params: { cabinet: '1-3', expected: '22', found: '21' } },
          ]),
          view('CABLE_SLACK_TOO_SHORT', [
            {
              handle: 'K1',
              params: { cableLengthM: '510.000', bundleLengthM: '500.000', slackM: '10.000' },
            },
          ]),
          view('BOX_NUMBER_DUPLICATE', [
            { handle: 'N1', params: { cabinet: '1-3', boxNumber: '9' } },
          ]),
          view('SPARE_CORES_MISMATCH', [
            { handle: 'S1', params: { expected: '48', found: '36', mainCores: 144 } },
          ]),
          view('LABEL_TYPE_MISMATCH', [
            { handle: 'L1', params: { role: 'bundle_label', expected: '12', found: '7' } },
          ]),
          view('HANDHOLE_TYPE_UNKNOWN', [{ handle: 'H1', params: { found: 'XX' } }]),
          view('LABEL_MISSING', [{ handle: 'M1', params: { role: 'box_number' } }]),
        ],
        7,
        0,
      ),
    );
    render();
    expect(
      await screen.findByText(/Cabinet .*1-3.*: .*22.* boxes written, .*21.* drawn/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cable .*510.000.* m, bundle .*500.000.* m, difference .*10.000.* m/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Number .*9.* is repeated in cabinet .*1-3/)).toBeInTheDocument();
    expect(
      screen.getByText(/Should be SP .*48.*main cable .*144.* cores.* but .*36.* is written/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The layer says .*12.* ways but the text says .*7.* ways/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Written «.*XX.*» is not an accepted type/)).toBeInTheDocument();
    expect(screen.getByText('Missing text: Box number')).toBeInTheDocument();
  });

  it('shows the old places (no params) without a detail line', async () => {
    api.listDrawingProblems.mockResolvedValue(
      list([view('LABEL_MISSING', [{ handle: 'M1' }])], 1, 0),
    );
    render();
    await screen.findByRole('table');
    expect(screen.queryByText(/Missing text/)).not.toBeInTheDocument();
  });

  it('says where to type a missing text, not where to move it', async () => {
    api.listDrawingProblems.mockResolvedValue(
      list([view('LABEL_MISSING', [{ handle: 'M1', suggestedLayer: 'TXTNMPER' }])], 1, 0),
    );
    render();
    expect(await screen.findByText(/Type the text on layer/)).toBeInTheDocument();
    expect(screen.queryByText(/Belongs on layer/)).not.toBeInTheDocument();
  });
});

describe('fix tools of the reading problems', () => {
  async function open(code: DrawingProblemCode, item: Partial<DrawingProblemItem> = {}) {
    api.listDrawingProblems.mockResolvedValue(list([view(code, [item])], 1, 0));
    render(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Fix this place' }));
    return user;
  }

  it('LABEL_MISSING types the text on the suggested layer', async () => {
    const user = await open('LABEL_MISSING', {
      handle: 'M1',
      suggestedLayer: 'TXTNMPER',
      params: { role: 'box_number' },
    });
    await user.type(screen.getByLabelText('Label text'), '9');
    await user.click(screen.getByRole('button', { name: 'Add the label' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'add_text', layer: 'TXTNMPER', x: 10, y: 20.5, text: '9', height: null },
      problem: { code: 'LABEL_MISSING', handle: 'M1' },
    });
  });

  it('HANDHOLE_TYPE_MISSING types the type text', async () => {
    const user = await open('HANDHOLE_TYPE_MISSING', { handle: 'H1', suggestedLayer: 'Notes' });
    await user.type(screen.getByLabelText('Label text'), 'DH');
    await user.click(screen.getByRole('button', { name: 'Add the label' }));
    expect(api.createCorrection.mock.calls[0]?.[2]).toMatchObject({
      correction: { kind: 'add_text', layer: 'Notes', text: 'DH' },
      problem: { code: 'HANDHOLE_TYPE_MISSING', handle: 'H1' },
    });
  });

  it('CABINET_BOX_COUNT_MISMATCH edits the written text, prefilled', async () => {
    const user = await open('CABINET_BOX_COUNT_MISMATCH', { handle: 'C1', text: '22B' });
    const input = screen.getByLabelText('Label text (edit it)');
    expect(input).toHaveValue('22B');
    await user.clear(input);
    await user.type(input, '21B');
    await user.click(screen.getByRole('button', { name: 'Save the label' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'set_text', handle: 'C1', text: '21B' },
      problem: { code: 'CABINET_BOX_COUNT_MISMATCH', handle: 'C1' },
    });
  });

  it('a route LABEL_TYPE_MISMATCH edits the text only (no "place an item" choice)', async () => {
    await open('LABEL_TYPE_MISMATCH', {
      handle: 'L1',
      text: '1way 7/3.5',
      params: { role: 'bundle_label', expected: '12', found: '1' },
    });
    expect(screen.getByLabelText('Label text (edit it)')).toHaveValue('1way 7/3.5');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('HANDHOLE_NOT_DRAWN places a handhole on a handhole layer only', async () => {
    const user = await open('HANDHOLE_NOT_DRAWN', { handle: 'T9', text: 'CH01' });
    const picker = await screen.findByLabelText('Layer of the item (its type)');
    expect(within(picker).getByRole('option', { name: 'HH — Handhole' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Notes/ })).not.toBeInTheDocument();
    await user.selectOptions(picker, 'HH');
    await user.click(screen.getByRole('button', { name: 'Place the item here' }));
    expect(api.createCorrection).toHaveBeenCalledWith(PROJECT, FILE, {
      correction: { kind: 'add_item', layer: 'HH', x: 10, y: 20 },
      problem: { code: 'HANDHOLE_NOT_DRAWN', handle: 'T9' },
    });
  });

  it.each(['BOX_NOT_REACHED', 'CABINET_ZONE_MISSING'] as const)(
    '%s is fixed in AutoCAD',
    async (code) => {
      api.listDrawingProblems.mockResolvedValue(list([view(code, [{ handle: 'B1' }])], 1, 0));
      render(true);
      expect(await screen.findByText(/fixed in AutoCAD/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Fix this place' })).not.toBeInTheDocument();
    },
  );
});
