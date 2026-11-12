import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportPreviewRow, WorkOrderImportPreviewResponse } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import {
  CONTRACTOR_2_ID,
  REGISTRATION_ID,
  SCOPE_BOX,
  SCOPE_SPLICE,
  contractor,
  projectContractors,
} from '@/test-utils/contractors';
import { ContractorImport } from './contractor-import';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const importApi = vi.hoisted(() => ({
  previewContractorImport: vi.fn(),
  commitContractorImport: vi.fn(),
}));
vi.mock('@/features/work-order-import/api/import-api', () => importApi);

const api = vi.hoisted(() => ({
  getAdminProjectContractors: vi.fn(),
  listContractors: vi.fn(),
}));
vi.mock('../api/contractors-api', () => api);

const SHA = 'c'.repeat(64);
const plain = (text: string | null) => (text ?? '').replace(/[⁦-⁩]/g, '');

const mapping = {
  code: 0,
  description: 1,
  unit: 2,
  scope: 3,
  quantity: 4,
  unitPrice: 5,
  workType: null,
  amount: null,
};

function row(
  rowNumber: number,
  code: string,
  scope: string | null,
  issues: ImportPreviewRow['issues'] = [],
): ImportPreviewRow {
  return {
    rowNumber,
    kind: 'item',
    raw: {
      code,
      description: `Item ${code}`,
      unit: 'no',
      quantity: '10',
      unitPrice: '5',
      workType: null,
      amount: null,
      scope,
    },
    code,
    description: `Item ${code}`,
    unit: 'no',
    quantity: '10',
    unitPrice: '5',
    workType: null,
    scope,
    sheetAmount: null,
    amount: '50',
    issues,
  };
}

const error = (code: ImportPreviewRow['issues'][number]['code'], params = {}) => ({
  code,
  severity: 'error' as const,
  field: null,
  params,
});

function preview(rows: ImportPreviewRow[]): WorkOrderImportPreviewResponse {
  return {
    file: { name: 'box.xlsx', sizeBytes: 800, sha256: SHA },
    sheets: [{ name: 'Sheet1', rowCount: rows.length }],
    sheetName: 'Sheet1',
    headerRow: 1,
    columns: ['A', 'B', 'C', 'D', 'E', 'F'].map((letter, index) => ({
      index,
      letter,
      header: ['Code', 'Description', 'Unit', 'Scope', 'Qty', 'Price'][index] ?? '',
    })),
    suggestedMapping: mapping,
    mapping,
    fileIssues: [],
    rows,
    summary: {
      rowCount: rows.length,
      headingCount: 0,
      skippedCount: 0,
      errorRowCount: rows.filter((entry) => entry.issues.length > 0).length,
      warningRowCount: 0,
      duplicateCodes: [],
      total: '0',
    },
  };
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(['PK'], 'box.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await user.upload(await screen.findByLabelText('Excel file (.xlsx)'), file);
  await screen.findByRole('heading', { name: '2. Sheet and columns' });
  return file;
}

describe('ContractorImport (admin upload of a subcontractor sheet)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getAdminProjectContractors.mockResolvedValue(projectContractors());
    api.listContractors.mockResolvedValue({
      items: [contractor(), contractor({ id: CONTRACTOR_2_ID, name: 'Delta Telecom' })],
    });
    importApi.previewContractorImport.mockResolvedValue(
      preview([row(2, '2-12-4-8', SCOPE_BOX), row(3, '2-12-4-8', SCOPE_SPLICE)]),
    );
    importApi.commitContractorImport.mockResolvedValue(projectContractors());
  });

  it('asks for the contractor and the date before any upload, then previews with the target', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} />);
    await screen.findByRole('option', { name: 'Delta Telecom' });
    expect(screen.queryByLabelText('Excel file (.xlsx)')).toBeNull();
    expect(screen.getByRole('link', { name: 'Add a new subcontractor' })).toHaveAttribute(
      'href',
      '/en/admin/contractors',
    );
    // The contractor already on the work order cannot be registered twice.
    expect(screen.getByRole('option', { name: 'Nile Cables (already registered)' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });
    const file = await upload(user);
    expect(importApi.previewContractorImport).toHaveBeenCalledWith(
      PROJECT_ID,
      file,
      { target: { kind: 'new', contractorId: CONTRACTOR_2_ID, registeredOn: '2026-11-07' } },
      expect.anything(),
    );
  });

  it('shows the scope column, scope as a mappable column and no work type', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} />);
    await screen.findByRole('option', { name: 'Delta Telecom' });
    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });
    await upload(user);

    expect(screen.getByLabelText('Scope of work')).toHaveValue('3');
    expect(screen.queryByLabelText(/^Work type/)).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Scope of work' })).toBeInTheDocument();
    expect(screen.getAllByText(SCOPE_BOX).length).toBeGreaterThan(0);
    expect(screen.getByText(SCOPE_SPLICE)).toBeInTheDocument();
  });

  it('words every issue with its figures, blocks the commit until the row is excluded, then commits', async () => {
    importApi.previewContractorImport.mockResolvedValue(
      preview([
        row(2, 'A-1', SCOPE_BOX),
        row(3, 'A-2', null, [
          error('QUANTITY_EXCEEDS_WORK_ORDER', {
            scope: '',
            workOrderQuantity: '100',
            reservedQuantity: '95',
            availableQuantity: '5',
          }),
        ]),
        row(4, 'A-3', SCOPE_SPLICE, [
          error('PRICE_EXCEEDS_CONTRACT', {
            contractPrice: '30',
            otherScopesPrice: '22',
            maxAllowedPrice: '8',
          }),
        ]),
        row(5, 'A-4', null, [error('WHOLE_AND_SCOPES_MIXED', { code: 'A-4' })]),
        row(6, 'A-5', SCOPE_BOX, [
          error('CODE_SCOPE_REPEATED', { scope: SCOPE_BOX, otherRows: '2' }),
        ]),
        row(7, 'A-6', SCOPE_BOX, [error('LINE_ALREADY_ASSIGNED', { scope: SCOPE_BOX })]),
        row(8, 'X-1', null, [error('NOT_IN_WORK_ORDER')]),
        row(9, 'A-8', null, [
          error('WORK_ORDER_MISMATCH', { workOrderValue: 'm' }),
          error('LEGACY_WORK_ORDER_LINE'),
        ]),
      ]),
    );
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} registrationId={REGISTRATION_ID} />);
    const file = await upload(user);
    expect(importApi.previewContractorImport).toHaveBeenCalledWith(
      PROJECT_ID,
      file,
      { target: { kind: 'append', registrationId: REGISTRATION_ID } },
      expect.anything(),
    );

    const text = (value: RegExp | string) => screen.getByText(value);
    expect(plain(text(/above what is available for scope Whole line/).textContent)).toContain(
      'available 5 of 100 (reserved 95)',
    );
    expect(
      plain(text(/scope prices add up to more than the contract price/).textContent),
    ).toContain('the most allowed is 8 (other scopes 22)');
    expect(text('Item A-4 cannot be given both whole and by scope')).toBeInTheDocument();
    expect(text(/same code and scope "تركيب البوكس" are in rows 2/)).toBeInTheDocument();
    expect(text(/already has this line and scope "تركيب البوكس"/)).toBeInTheDocument();
    expect(text('The code is not a line of the work order')).toBeInTheDocument();
    expect(text(/differs from the work order \(m\)/)).toBeInTheDocument();
    expect(text(/legacy line and cannot be given/)).toBeInTheDocument();

    const commit = screen.getByRole('button', { name: 'Register the lines' });
    expect(commit).toBeDisabled();
    expect(
      screen.getByText('Rows with errors are still included: exclude them'),
    ).toBeInTheDocument();

    // Exclude every row that has an error: the first row alone is fine.
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    expect(commit).toBeEnabled();
    await user.click(commit);
    await waitFor(() => expect(importApi.commitContractorImport).toHaveBeenCalled());
    const [projectId, sentFile, payload] = importApi.commitContractorImport.mock.calls[0] as [
      string,
      File,
      Record<string, unknown>,
    ];
    expect(projectId).toBe(PROJECT_ID);
    expect(sentFile).toBe(file);
    expect(payload).toMatchObject({
      fileSha256: SHA,
      sheetName: 'Sheet1',
      headerRow: 1,
      excludedRowNumbers: [3, 4, 5, 6, 7, 8, 9],
      target: { kind: 'append', registrationId: REGISTRATION_ID },
      mapping: { code: 0, scope: 3, workType: null, amount: null },
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/en/admin/projects/${PROJECT_ID}`));
  });

  it('lets the admin exclude a single row by hand', async () => {
    importApi.previewContractorImport.mockResolvedValue(
      preview([row(2, 'A-1', SCOPE_BOX), row(3, 'A-2', null, [error('NOT_IN_WORK_ORDER')])]),
    );
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} registrationId={REGISTRATION_ID} />);
    await upload(user);
    const commit = screen.getByRole('button', { name: 'Register the lines' });
    expect(commit).toBeDisabled();
    await user.click(screen.getByLabelText('Include row 3'));
    expect(commit).toBeEnabled();
  });

  it('shows the server IMPORT_INVALID rows in words', async () => {
    importApi.commitContractorImport.mockRejectedValue(
      new ApiClientError('IMPORT_INVALID', 422, {
        reason: 'ROW_ERRORS',
        fileIssues: [],
        rows: [
          {
            rowNumber: 2,
            issues: [
              error('QUANTITY_EXCEEDS_WORK_ORDER', {
                scope: SCOPE_BOX,
                workOrderQuantity: '100',
                reservedQuantity: '99',
                availableQuantity: '1',
              }),
            ],
          },
        ],
        duplicateCodes: [],
      }),
    );
    importApi.previewContractorImport.mockResolvedValue(preview([row(2, 'A-1', SCOPE_BOX)]));
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} registrationId={REGISTRATION_ID} />);
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Register the lines' }));
    const alert = await screen.findByRole('alert');
    expect(plain(alert.textContent)).toContain('for scope تركيب البوكس: available 1 of 100');
  });

  it('shows a server 409 of the commit in words', async () => {
    importApi.commitContractorImport.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'CONTRACTOR_ALREADY_REGISTERED' }),
    );
    importApi.previewContractorImport.mockResolvedValue(preview([row(2, 'A-1', null)]));
    const user = userEvent.setup();
    renderScreen(<ContractorImport projectId={PROJECT_ID} />);
    await screen.findByRole('option', { name: 'Delta Telecom' });
    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });
    await upload(user);
    await user.click(screen.getByRole('button', { name: 'Register the lines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This subcontractor is already registered on the work order.',
    );
  });

  it('explains that a work order is needed when the project has none', async () => {
    api.getAdminProjectContractors.mockResolvedValue(
      projectContractors({ workOrderId: null, registrations: [], availability: [] }),
    );
    renderScreen(<ContractorImport projectId={PROJECT_ID} />);
    expect(await screen.findByText(/no work order yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Excel file (.xlsx)')).toBeNull();
  });
});
