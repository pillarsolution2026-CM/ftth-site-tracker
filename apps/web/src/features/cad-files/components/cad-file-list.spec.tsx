import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CadFileSummary } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { CadFileList, CadFileListView } from './cad-file-list';

const api = vi.hoisted(() => ({ listCadFiles: vi.fn(), uploadCadFile: vi.fn() }));
vi.mock('../api/cad-api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../api/cad-api')),
  ...api,
}));

const upload = {
  kind: 'general' as const,
  onKindChange: vi.fn(),
  conflict: null,
  declinedKind: null,
  onConfirmNewVersion: vi.fn(),
  onDeclineNewVersion: vi.fn(),
  onFileChange: vi.fn(),
  progress: null,
  uploading: false,
  badName: false,
  errorCode: null,
  lastName: null,
};

function file(
  status: CadFileSummary['status'],
  overrides: Partial<CadFileSummary> = {},
): CadFileSummary {
  return {
    id: '1f8fad5b-d9cb-469f-a165-70867728950e',
    projectId: PROJECT_ID,
    originalName: 'route-14.dxf',
    format: 'dxf',
    sizeBytes: 2048,
    sha256: 'c'.repeat(64),
    status,
    drawingKind: 'general',
    supersededAt: null,
    supersededById: null,
    uploadedById: null,
    counts: null,
    warningCount: 0,
    errorCode: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    processedAt: null,
    ...overrides,
  };
}

describe('CadFileListView', () => {
  it.each([
    ['queued', 'Queued', '…'],
    ['processing', 'Processing', '⟳'],
    ['processed', 'Processed', '✓'],
    ['failed', 'Failed', '✕'],
  ] as const)('shows %s with an icon and text, not colour alone', (status, label, icon) => {
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[file(status)]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    const badge = screen.getByText(label).closest('[data-status]');
    expect(badge).toHaveAttribute('data-status', status);
    expect(badge).toHaveTextContent(icon);
  });

  it('explains a failure by its code', () => {
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[file('failed', { errorCode: 'CONVERTER_FAILED' })]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    expect(screen.getByText('The DWG converter failed')).toBeInTheDocument();
  });

  it('shows counts once processed and links to the detail page', () => {
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[
          file('processed', {
            counts: { layers: 12, inserts: 34, texts: 56, curves: 78 },
            warningCount: 2,
          }),
        ]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    const row = screen.getByRole('row', { name: /route-14\.dxf/ });
    for (const count of ['12', '34', '56', '78']) {
      expect(within(row).getByText(count)).toBeInTheDocument();
    }
    expect(within(row).getByRole('link')).toHaveAttribute(
      'href',
      '/en/p/1f8fad5b-d9cb-469f-a165-70867728950e',
    );
  });

  it('shows the upload control only with the write permission and surfaces upload errors', () => {
    const { unmount } = renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[]}
        errorCode={null}
        canWrite
        upload={{ ...upload, errorCode: 'FILE_TOO_LARGE' }}
      />,
    );
    expect(screen.getByLabelText('Upload a CAD file')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The file is larger than the allowed size');
    unmount();
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    expect(screen.queryByLabelText('Upload a CAD file')).not.toBeInTheDocument();
  });
});

describe('CadFileListView sections (ADR-040)', () => {
  const ID = (n: number) => `1f8fad5b-d9cb-469f-a165-70867728950${n}`;

  it('groups into General and Secondary and hides old versions (owner 2026-11-11)', () => {
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[
          file('processed', {
            id: ID(1),
            originalName: 'old-general.dxf',
            supersededAt: '2026-03-02T10:00:00.000Z',
            supersededById: ID(2),
            createdAt: '2026-03-02T09:00:00.000Z',
          }),
          file('processed', {
            id: ID(2),
            originalName: 'new-general.dxf',
            createdAt: '2026-03-01T10:00:00.000Z',
          }),
          file('processed', { id: ID(3), originalName: 'sec.dxf', drawingKind: 'secondary' }),
        ]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    const general = screen.getByRole('region', { name: 'General (main)' });
    const rows = within(general).getAllByRole('row');
    expect(rows).toHaveLength(2); // header + the current version only
    expect(rows[1]).toHaveTextContent('new-general.dxf');
    expect(within(general).queryByText('old-general.dxf')).not.toBeInTheDocument();
    expect(within(general).queryByText('Old version')).not.toBeInTheDocument();
    const secondary = screen.getByRole('region', { name: 'Secondary' });
    expect(within(secondary).getByText('sec.dxf')).toBeInTheDocument();
  });

  it('says so when a section has no file yet', () => {
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[file('processed')]}
        errorCode={null}
        canWrite={false}
        upload={upload}
      />,
    );
    expect(screen.getByText('No Secondary has been uploaded yet')).toBeInTheDocument();
    expect(screen.queryByText('No General has been uploaded yet')).not.toBeInTheDocument();
  });

  it('lets the PM pick the kind with radio buttons and locks the file input until then', async () => {
    const user = userEvent.setup();
    const onKindChange = vi.fn();
    renderScreen(
      <CadFileListView
        basePath="/en/p"
        files={[]}
        errorCode={null}
        canWrite
        upload={{ ...upload, kind: null, onKindChange }}
      />,
    );
    expect(screen.getByLabelText('Upload a CAD file')).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Secondary' }));
    expect(onKindChange).toHaveBeenCalledWith('secondary');
    expect(screen.getByRole('radio', { name: 'General (main)' })).toBeInTheDocument();
  });
});

describe('CadFileList upload with a kind', () => {
  const CURRENT = '1f8fad5b-d9cb-469f-a165-70867728950a';
  const kindExists = () =>
    new ApiClientError('CONFLICT', 409, {
      reason: 'KIND_EXISTS',
      kind: 'general',
      currentFileId: CURRENT,
      currentFileName: 'current.dxf',
    });

  beforeEach(() => {
    api.listCadFiles.mockReset().mockResolvedValue({ items: [] });
    api.uploadCadFile.mockReset();
  });

  async function pickAndUpload(user: ReturnType<typeof userEvent.setup>) {
    renderScreen(<CadFileList projectId={PROJECT_ID} />);
    await user.click(await screen.findByRole('radio', { name: 'General (main)' }));
    const input = screen.getByLabelText('Upload a CAD file');
    const picked = new File(['0'], 'route.dxf');
    await user.upload(input, picked);
    return picked;
  }

  it('sends the chosen kind without newVersion', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockResolvedValue(file('queued'));
    const picked = await pickAndUpload(user);
    await waitFor(() => expect(api.uploadCadFile).toHaveBeenCalledTimes(1));
    expect(api.uploadCadFile.mock.calls[0]?.slice(0, 4)).toEqual([
      PROJECT_ID,
      picked,
      'general',
      false,
    ]);
  });

  it('asks «new version?» on KIND_EXISTS and re-sends the same file with newVersion on yes', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockRejectedValueOnce(kindExists()).mockResolvedValueOnce(file('queued'));
    const picked = await pickAndUpload(user);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Is this a new version of the General?');
    expect(dialog).toHaveTextContent('current.dxf');
    await user.click(within(dialog).getByRole('button', { name: 'Yes, a new version' }));
    await waitFor(() => expect(api.uploadCadFile).toHaveBeenCalledTimes(2));
    const second = api.uploadCadFile.mock.calls[1] as unknown[];
    expect(second[1]).toBe(picked);
    expect(second[2]).toBe('general');
    expect(second[3]).toBe(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('cancels on «no» with the notice that the file was not uploaded', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockRejectedValueOnce(kindExists());
    await pickAndUpload(user);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'No' }));
    expect(
      await screen.findByText('A work order has only one General — the file was not uploaded'),
    ).toBeInTheDocument();
    expect(api.uploadCadFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows other upload errors normally, without the question', async () => {
    const user = userEvent.setup();
    api.uploadCadFile.mockRejectedValueOnce(new ApiClientError('FILE_TOO_LARGE', 413));
    await pickAndUpload(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file is larger than the allowed size',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
