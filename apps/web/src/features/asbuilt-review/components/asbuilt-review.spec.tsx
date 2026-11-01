import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AsBuiltExport, AsBuiltLineString } from '@ftth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAccess } from '@/features/projects/model/project-access';
import { PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import { EDIT_ID, makeDetail, makeEdit } from '../model/asbuilt-fixtures';
import { ComparisonDrawing, DrawingLegend } from './comparison-drawing';
import { EditDetailScreen } from './edit-detail';
import { EditList } from './edit-list';
import { ExportsPanelView } from './exports-panel';

const SUPERVISOR_ACCESS: ProjectAccess = {
  status: 'member',
  projectId: PROJECT_ID,
  projectName: 'Project',
  roles: ['supervisor'],
  isAdmin: false,
};
const API = `/api/projects/${PROJECT_ID}/asbuilt`;

interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

/** Stubs `fetch`; every request is recorded and answered by the handler. */
function stubApi(handler: Handler) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const answer = handler(call) ?? { status: 404, body: { code: 'NOT_FOUND', message: 'x' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('ComparisonDrawing', () => {
  const design: AsBuiltLineString = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [120, 0],
    ],
  };
  const proposed: AsBuiltLineString = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [60, 10],
      [120, 0],
    ],
  };

  it('draws the design dashed and the proposal solid, with a text legend', () => {
    renderScreen(
      <>
        <ComparisonDrawing
          design={design}
          current={null}
          proposed={proposed}
          designCode="R-014"
          proposedLabel="R-014 as built"
          crsEpsg={32636}
        />
        <DrawingLegend />
      </>,
    );
    const designPath = screen
      .getByTestId('comparison-drawing')
      .querySelector('[data-layer="design"] path');
    const proposedPath = screen
      .getByTestId('comparison-drawing')
      .querySelector('[data-layer="proposed"] path');
    expect(designPath).toHaveAttribute('stroke-dasharray');
    expect(proposedPath).not.toHaveAttribute('stroke-dasharray');
    expect(screen.getByText('Design (dashed line)')).toBeInTheDocument();
    expect(screen.getByText('Proposed by the supervisor (solid thick line)')).toBeInTheDocument();
    expect(screen.getByText('R-014')).toBeInTheDocument();
    expect(screen.getByText('R-014 as built')).toBeInTheDocument();
    expect(screen.getByText(/EPSG:32636/)).toBeInTheDocument();
  });

  it('draws points with a different symbol per layer', () => {
    renderScreen(
      <ComparisonDrawing
        design={{ type: 'Point', coordinates: [10, 10] }}
        current={{ type: 'Point', coordinates: [11, 10] }}
        proposed={{ type: 'Point', coordinates: [12, 11] }}
        designCode={null}
        proposedLabel={null}
        crsEpsg={32636}
      />,
    );
    const svg = screen.getByTestId('comparison-drawing');
    expect(svg.querySelector('[data-layer="design"] rect')).not.toBeNull();
    expect(svg.querySelector('[data-layer="current"] circle')).not.toBeNull();
    expect(svg.querySelector('[data-layer="proposed"] polygon')).not.toBeNull();
  });
});

describe('EditDetailScreen', () => {
  const detailUrl = `${API}/edits/${EDIT_ID}`;

  function serve(
    detail = makeDetail({ flags: ['BASE_OUTDATED', 'CLOCK_AHEAD'] }),
    extra?: Handler,
  ) {
    return stubApi((call) => {
      const custom = extra?.(call);
      if (custom) return custom;
      if (call.method === 'GET' && call.url === detailUrl) return { body: detail };
      return undefined;
    });
  }

  it('shows the lengths, the exact difference and the flags in words', async () => {
    serve();
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />);
    expect(await screen.findByTestId('design-length')).toHaveTextContent('120.000 m');
    expect(screen.getByTestId('proposed-length')).toHaveTextContent('122.066 m');
    expect(screen.getByTestId('length-difference')).toHaveTextContent('+2.066 m');
    expect(screen.getByText('Outdated base')).toBeInTheDocument();
    expect(screen.getByText(/Another edit of this feature was approved after/)).toBeInTheDocument();
    expect(screen.getByText(/phone clock was ahead/)).toBeInTheDocument();
    expect(screen.getByText('The duct bends around the new pole')).toBeInTheDocument();
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
  });

  it('approves and refetches', async () => {
    const user = userEvent.setup();
    let approved = false;
    const calls = serve(undefined, (call) => {
      if (call.method === 'POST' && call.url === `${detailUrl}/approve`) {
        approved = true;
        return { body: makeEdit({ status: 'approved', approvedVersion: 1 }) };
      }
      if (call.method === 'GET' && call.url === detailUrl && approved) {
        return {
          body: makeDetail({ status: 'approved', approvedVersion: 1 }, { approvable: false }),
        };
      }
      return undefined;
    });
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `${detailUrl}/approve`,
    ]);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText(/already been reviewed/)).toBeInTheDocument();
  });

  it('disables approve with an explanation when the base is stale, but allows reject', async () => {
    serve(makeDetail({ flags: ['BASE_OUTDATED'] }, { approvable: false }));
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(
      /another edit of this feature was approved after it was drawn/,
    );
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('shows no review buttons to a user without asbuilt:review', async () => {
    serve();
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />, {
      access: SUPERVISOR_ACCESS,
    });
    await screen.findByTestId('design-length');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText('You do not have permission to review edits.')).toBeInTheDocument();
  });

  it('lets a QC reviewer approve', async () => {
    serve();
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />, {
      access: QC_ACCESS,
    });
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it.each([
    [403, 'FORBIDDEN', 'SELF_REVIEW', /cannot review an edit you recorded yourself/],
    [409, 'CONFLICT', 'NOT_PENDING', /already reviewed by someone else/],
    [409, 'CONFLICT', 'STALE_BASE', /approved in the meantime/],
  ] as const)(
    'maps %s %s %s to a clear message and refetches',
    async (status, code, reason, text) => {
      const user = userEvent.setup();
      const calls = serve(undefined, (call) =>
        call.method === 'POST'
          ? { status, body: { code, message: code, details: { reason } } }
          : undefined,
      );
      renderScreen(
        <EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />,
      );
      await user.click(await screen.findByRole('button', { name: 'Approve' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      await waitFor(() =>
        expect(calls.filter((call) => call.method === 'GET' && call.url === detailUrl).length).toBe(
          2,
        ),
      );
    },
  );

  it('needs a reason to reject, then sends it trimmed', async () => {
    const user = userEvent.setup();
    const calls = serve(undefined, (call) =>
      call.method === 'POST' && call.url === `${detailUrl}/reject`
        ? { body: makeEdit({ status: 'rejected', reviewReason: 'Wrong duct' }) }
        : undefined,
    );
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('alertdialog');

    await user.click(within(dialog).getByRole('button', { name: 'Reject the edit' }));
    expect(within(dialog).getByText('A reason is required')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Reason'), '  Wrong duct  ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject the edit' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toMatchObject({ url: `${detailUrl}/reject`, body: { reason: 'Wrong duct' } });
  });

  it('shows the label-only edit without a drawing of the proposal', async () => {
    serve(makeDetail({ kind: 'label', geometry: null, lengthM: null, label: 'New name' }));
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/en/list" />);
    expect(await screen.findByText('New name')).toBeInTheDocument();
    expect(screen.getByText(/changes the label only/)).toBeInTheDocument();
    expect(screen.queryByTestId('length-difference')).not.toBeInTheDocument();
  });

  it('is right-to-left friendly: Arabic text with the lengths kept left-to-right', async () => {
    serve();
    renderScreen(<EditDetailScreen projectId={PROJECT_ID} editId={EDIT_ID} listPath="/ar/list" />, {
      locale: 'ar',
    });
    const length = await screen.findByTestId('design-length');
    expect(length.closest('[dir="ltr"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'اعتماد' })).toBeInTheDocument();
    expect(screen.getByTestId('comparison-drawing')).toHaveAttribute('direction', 'ltr');
  });
});

describe('EditList', () => {
  beforeEach(() => {
    stubApi((call) =>
      call.url.startsWith(`${API}/edits`)
        ? {
            body: {
              total: 45,
              items: [
                makeEdit({ flags: ['FEATURE_REMOVED'] }),
                makeEdit({
                  id: '8f8fad5b-d9cb-469f-a165-70867728950e',
                  kind: 'move',
                  featureType: 'box',
                  geometry: { type: 'Point', coordinates: [1, 2] },
                  lengthM: null,
                  status: 'approved',
                }),
              ],
            },
          }
        : undefined,
    );
  });

  it('lists pending first with the columns, flags and status as text', async () => {
    renderScreen(<EditList projectId={PROJECT_ID} />);
    const table = await screen.findByRole('table', { name: 'As-Built review' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('Hassan Ali')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Reshape route')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Route')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Feature removed')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('122.066 m')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Approved')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('No flags')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toHaveValue('pending');
    expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toContain(
      `${API}/edits?status=pending&limit=20&offset=0`,
    );
  });

  it('pages with limit/offset and filters by status', async () => {
    const user = userEvent.setup();
    renderScreen(<EditList projectId={PROJECT_ID} />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toContain(
        `${API}/edits?status=pending&limit=20&offset=20`,
      ),
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toContain(
        `${API}/edits?limit=20&offset=0`,
      ),
    );
  });

  it('shows no export panel to a user without asbuilt:export', async () => {
    renderScreen(<EditList projectId={PROJECT_ID} />, { access: QC_ACCESS });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Export As-Built DXF' })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some((call) => String(call[0]).includes('/exports'))).toBe(
      false,
    );
  });

  it('shows the export panel to a PM', async () => {
    renderScreen(<EditList projectId={PROJECT_ID} />);
    expect(await screen.findByRole('button', { name: 'Export As-Built DXF' })).toBeInTheDocument();
  });
});

describe('ExportsPanelView', () => {
  const base: AsBuiltExport = {
    id: '9f8fad5b-d9cb-469f-a165-70867728950e',
    revisionId: '4f8fad5b-d9cb-469f-a165-70867728950e',
    status: 'queued',
    requestedBy: '5f8fad5b-d9cb-469f-a165-70867728950e',
    requestedAt: '2026-05-02T08:00:00.000+00:00',
    finishedAt: null,
    stats: null,
    sizeBytes: null,
    error: null,
  };
  const render = (items: AsBuiltExport[], extra: { running?: boolean } = {}) =>
    renderScreen(
      <ExportsPanelView
        items={items}
        running={extra.running ?? false}
        requesting={false}
        errorKey={null}
        onRequest={vi.fn()}
        fileUrl={(id) => `${API}/exports/${id}/file`}
      />,
    );

  it('offers the download link only when done', () => {
    render(
      [
        base,
        {
          ...base,
          id: 'af8fad5b-d9cb-469f-a165-70867728950e',
          status: 'done',
          sizeBytes: 2048,
          stats: { designFeatures: 10, editedFeatures: 2, addedFeatures: 1 },
        },
      ],
      { running: true },
    );
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText(/refreshes by itself/)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Download DXF' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      `${API}/exports/af8fad5b-d9cb-469f-a165-70867728950e/file`,
    );
    expect(screen.getByText('10 design, 2 edited, 1 added')).toBeInTheDocument();
  });

  it('shows the error code of a failed export', () => {
    render([{ ...base, status: 'failed', error: 'MAX_ATTEMPTS_EXCEEDED' }]);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('MAX_ATTEMPTS_EXCEEDED')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download DXF' })).not.toBeInTheDocument();
  });
});
