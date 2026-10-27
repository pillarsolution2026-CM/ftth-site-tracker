import { screen, within } from '@testing-library/react';
import type { CadFileSummary } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { CadFileListView } from './cad-file-list';

const upload = {
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
