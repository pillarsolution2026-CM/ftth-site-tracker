import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CadFileSummary } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import { SITE_A, SITE_B, draftRevision, drawing, siteDrawings } from '@/test-utils/site-drawings';
import { CadFileList } from './cad-file-list';

const api = vi.hoisted(() => ({
  listCadFiles: vi.fn(),
  listSiteDrawings: vi.fn(),
  uploadCadFile: vi.fn(),
  assignDrawingSite: vi.fn(),
  withdrawDrawing: vi.fn(),
  listWorkOrders: vi.fn(),
  getSitePublishReadiness: vi.fn(),
}));
vi.mock('../api/cad-api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../api/cad-api')),
  listCadFiles: api.listCadFiles,
  listSiteDrawings: api.listSiteDrawings,
  uploadCadFile: api.uploadCadFile,
  assignDrawingSite: api.assignDrawingSite,
  withdrawDrawing: api.withdrawDrawing,
}));
vi.mock('@/features/work-orders/api/work-orders-api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/features/work-orders/api/work-orders-api')),
  listWorkOrders: api.listWorkOrders,
}));
vi.mock('@/features/design-revisions/api/design-revisions-api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '@/features/design-revisions/api/design-revisions-api',
  )),
  getSitePublishReadiness: api.getSitePublishReadiness,
}));

function file(id: string, name: string, status: CadFileSummary['status']): CadFileSummary {
  return {
    id,
    projectId: PROJECT_ID,
    originalName: name,
    format: 'dxf',
    sizeBytes: 2048,
    sha256: 'c'.repeat(64),
    status,
    drawingKind: 'general',
    drawingId: '2a9fbd6c-e0dc-4a70-9876-81778839a61f',
    siteId: null,
    drawingOrdinal: 1,
    supersededAt: null,
    supersededById: null,
    uploadedById: null,
    counts: null,
    warningCount: 0,
    errorCode: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    processedAt: null,
  };
}

const UNASSIGNED = drawing(9, { siteId: null, siteName: null, currentFileName: 'old-general.dxf' });

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.listCadFiles.mockResolvedValue({ items: [] });
  api.listSiteDrawings.mockResolvedValue(siteDrawings());
  api.listWorkOrders.mockResolvedValue({ items: [] });
  api.assignDrawingSite.mockResolvedValue(undefined);
  api.withdrawDrawing.mockResolvedValue(undefined);
});

describe('drawings grouped by site (ADR-049 part B)', () => {
  it('lists each site with its General and numbered Secondaries and their states', async () => {
    api.listCadFiles.mockResolvedValue({
      items: [file(drawing(1).currentFileId as string, 'file-1.dxf', 'processed')],
    });
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const site = await screen.findByRole('region', { name: 'Site A' });
    const rows = within(site).getAllByRole('row');
    expect(rows).toHaveLength(4); // header + General + Secondary 1 + Secondary 2
    expect(rows[1]).toHaveTextContent('General');
    expect(rows[1]).toHaveTextContent('Published, revision');
    expect(rows[1]).toHaveTextContent('Processed');
    expect(rows[2]).toHaveTextContent(/Secondary \u20661\u2069/);
    expect(rows[2]).toHaveTextContent('Draft, not published');
    expect(rows[3]).toHaveTextContent(/Secondary \u20662\u2069/);
    expect(rows[3]).toHaveTextContent('Not built yet');
    // The state has an icon and a word, not colour alone.
    expect(within(rows[2] as HTMLElement).getByText('✎')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('region', { name: 'Site B' })).toHaveTextContent(
      'This site has no drawings yet',
    );
  });

  it('says what a site still lacks', async () => {
    api.listSiteDrawings.mockResolvedValue(
      siteDrawings({
        sites: [{ siteId: SITE_A, name: 'Site A', drawings: [drawing(1)] }],
      }),
    );
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    expect(await screen.findByText(/Still missing: Secondary/)).toBeInTheDocument();
  });

  it('offers «Withdraw from the site» only for a drawing never published, after a confirmation', async () => {
    const user = userEvent.setup();
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const site = await screen.findByRole('region', { name: 'Site A' });
    // General is published: no button. The two Secondaries were never published.
    expect(within(site).getAllByRole('button', { name: 'Withdraw from the site' })).toHaveLength(2);
    const row = within(site).getByRole('row', { name: /Secondary \u20662\u2069/ });
    await user.click(within(row).getByRole('button', { name: 'Withdraw from the site' }));
    const dialog = within(row).getByRole('alertdialog');
    expect(api.withdrawDrawing).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, withdraw it' }));
    await waitFor(() =>
      expect(api.withdrawDrawing).toHaveBeenCalledWith(PROJECT_ID, drawing(3).id),
    );
  });

  it('keeps the actions away from a role without design:write', async () => {
    renderScreen(<CadFileList projectId={PROJECT_ID} />, { access: QC_ACCESS });
    await screen.findByRole('region', { name: 'Site A' });
    expect(
      screen.queryByRole('button', { name: 'Withdraw from the site' }),
    ).not.toBeInTheDocument();
  });

  it('groups drawings without a site under «No site» and links one once picked', async () => {
    const user = userEvent.setup();
    api.listSiteDrawings.mockResolvedValue(siteDrawings({ unassigned: [UNASSIGNED] }));
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const group = await screen.findByRole('region', { name: 'No site' });
    const link = within(group).getByRole('button', { name: 'Link to a site' });
    expect(link).toBeDisabled();
    await user.selectOptions(within(group).getByLabelText('Site'), SITE_B);
    await user.click(link);
    await waitFor(() =>
      expect(api.assignDrawingSite).toHaveBeenCalledWith(PROJECT_ID, UNASSIGNED.id, {
        siteId: SITE_B,
      }),
    );
  });

  it('shows the refusal of linking a second General in plain words', async () => {
    const user = userEvent.setup();
    api.listSiteDrawings.mockResolvedValue(siteDrawings({ unassigned: [UNASSIGNED] }));
    api.assignDrawingSite.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'GENERAL_EXISTS', siteId: SITE_A }),
    );
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const group = await screen.findByRole('region', { name: 'No site' });
    await user.selectOptions(within(group).getByLabelText('Site'), SITE_A);
    await user.click(within(group).getByRole('button', { name: 'Link to a site' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has its General drawing');
  });

  it('offers the publishing checklist of a site that has a draft', async () => {
    const user = userEvent.setup();
    api.getSitePublishReadiness.mockResolvedValue({
      siteId: SITE_A,
      checks: [],
      canPublish: false,
      revisionId: null,
      drawingKind: null,
      siteRevisionIds: [draftRevision(2).id],
      drawings: [],
      needsAcknowledgement: false,
      cabinets: null,
      cabinetsInOtherSites: [],
      warningCount: 0,
      switchedOff: [],
    });
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const site = await screen.findByRole('region', { name: 'Site A' });
    expect(screen.getByRole('region', { name: 'Site B' })).not.toHaveTextContent('checklist');
    await user.click(within(site).getByRole('button', { name: 'Publishing checklist' }));
    expect(await within(site).findByRole('button', { name: 'Publish the site' })).toBeDisabled();
    expect(api.getSitePublishReadiness).toHaveBeenCalledWith(PROJECT_ID, SITE_A);
  });
});

describe('upload dialog (ADR-049 part B)', () => {
  const picked = () => new File(['0'], 'route.dxf');

  it('says so and links to the work order when it has no sites', async () => {
    api.listSiteDrawings.mockResolvedValue({ sites: [], unassigned: [] });
    api.listWorkOrders.mockResolvedValue({ items: [{ id: 'w1' }] });
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    expect(await screen.findByText(/has no sites yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('CAD file (.dwg or .dxf)')).not.toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Sites section/ });
    expect(link.getAttribute('href')).toMatch(/\/work-orders\/w1#sites-title$/);
  });

  it('locks the file input until site, kind and target are chosen', async () => {
    const user = userEvent.setup();
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    const input = await screen.findByLabelText('CAD file (.dwg or .dxf)');
    expect(input).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Site'), SITE_A);
    expect(input).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Secondary' }));
    expect(input).toBeDisabled(); // Secondaries exist: new drawing or new version?
    await user.click(screen.getByRole('radio', { name: 'A new Secondary drawing' }));
    expect(input).toBeEnabled();
  });

  it('a General that exists offers only a new version of it', async () => {
    const user = userEvent.setup();
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_A);
    await user.click(screen.getByRole('radio', { name: 'General (main)' }));
    expect(screen.getByText(/already has its General/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'The General drawing of the site' })).toBeNull();
    expect(screen.getByRole('radio', { name: /new version of General/ })).toBeChecked();
    expect(screen.getByLabelText('CAD file (.dwg or .dxf)')).toBeEnabled();
  });

  it('a site without a General offers a new General', async () => {
    const user = userEvent.setup();
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_B);
    await user.click(screen.getByRole('radio', { name: 'General (main)' }));
    expect(screen.getByRole('radio', { name: 'The General drawing of the site' })).toBeChecked();
  });

  it('sends siteId, kind, target and the drawing for a new version of a Secondary', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockResolvedValue(file('f', 'route.dxf', 'queued'));
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_A);
    await user.click(screen.getByRole('radio', { name: 'Secondary' }));
    await user.click(screen.getByRole('radio', { name: /new version of Secondary \u20662\u2069/ }));
    const file1 = picked();
    await user.upload(screen.getByLabelText('CAD file (.dwg or .dxf)'), file1);
    await waitFor(() => expect(api.uploadCadFile).toHaveBeenCalledTimes(1));
    const call = api.uploadCadFile.mock.calls[0] as unknown[];
    expect(call[1]).toBe(file1);
    expect(call[2]).toEqual({
      siteId: SITE_A,
      kind: 'secondary',
      target: 'new_version',
      drawingId: drawing(3).id,
    });
  });

  it('sends a new Secondary drawing', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockResolvedValue(file('f', 'route.dxf', 'queued'));
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_B);
    await user.click(screen.getByRole('radio', { name: 'Secondary' }));
    // Nothing to version in an empty site: «new drawing» is already chosen.
    await user.upload(screen.getByLabelText('CAD file (.dwg or .dxf)'), picked());
    await waitFor(() => expect(api.uploadCadFile).toHaveBeenCalledTimes(1));
    expect((api.uploadCadFile.mock.calls[0] as unknown[])[2]).toEqual({
      siteId: SITE_B,
      kind: 'secondary',
      target: 'new_drawing',
    });
  });

  it('shows GENERAL_EXISTS in plain words and does not ask anything else', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'GENERAL_EXISTS',
        siteId: SITE_B,
        drawingId: drawing(1).id,
        currentFileName: 'current.dxf',
      }),
    );
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_B);
    await user.click(screen.getByRole('radio', { name: 'General (main)' }));
    await user.upload(screen.getByLabelText('CAD file (.dwg or .dxf)'), picked());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('already has its General drawing (current.dxf)');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows other upload errors with the generic message', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockRejectedValue(new ApiClientError('FILE_TOO_LARGE', 413));
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.selectOptions(await screen.findByLabelText('Site'), SITE_B);
    await user.click(screen.getByRole('radio', { name: 'General (main)' }));
    await user.upload(screen.getByLabelText('CAD file (.dwg or .dxf)'), picked());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file is larger than the allowed size',
    );
  });

  it('is hidden without cad_files:write', async () => {
    renderScreen(<CadFileList projectId={PROJECT_ID} />, { access: QC_ACCESS });
    await screen.findByRole('region', { name: 'Site A' });
    expect(screen.queryByLabelText('CAD file (.dwg or .dxf)')).not.toBeInTheDocument();
  });
});
