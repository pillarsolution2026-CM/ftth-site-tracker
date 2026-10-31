import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ImportPreviewRow,
  WorkOrderDetail,
  WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, QC_ACCESS, renderScreen } from '@/test-utils/render';
import { ContractImport } from '@/features/contracts/components/contract-import';
import { ImportWizard } from './import-wizard';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const previewImport = vi.fn();
const commitImport = vi.fn();
const previewContractImport = vi.fn();
const commitContractImport = vi.fn();
vi.mock('../api/import-api', () => ({
  previewImport: (...args: unknown[]) => previewImport(...args),
  commitImport: (...args: unknown[]) => commitImport(...args),
  previewContractImport: (...args: unknown[]) => previewContractImport(...args),
  commitContractImport: (...args: unknown[]) => commitContractImport(...args),
}));

const listWorkOrders = vi.fn();
const getContractItems = vi.fn();
vi.mock('@/features/work-orders/api/work-orders-api', () => ({
  listWorkOrders: (...args: unknown[]) => listWorkOrders(...args),
  getContractItems: (...args: unknown[]) => getContractItems(...args),
}));

const SHA = 'b'.repeat(64);
const NEW_ID = '9f8fad5b-d9cb-469f-a165-70867728950e';

function row(
  rowNumber: number,
  code: string,
  amount: string | null,
  issues: ImportPreviewRow['issues'] = [],
): ImportPreviewRow {
  return {
    rowNumber,
    kind: 'item',
    raw: {
      code,
      description: `Item ${code}`,
      unit: 'm',
      quantity: '1',
      unitPrice: '1',
      workType: 'مدني',
      amount: null,
    },
    code,
    description: `Item ${code}`,
    unit: 'm',
    quantity: '1',
    unitPrice: '1',
    workType: 'civil',
    sheetAmount: null,
    amount,
    issues,
  };
}

const mapping = {
  code: 0,
  description: 1,
  unit: 2,
  quantity: 3,
  unitPrice: 4,
  workType: 5,
  amount: null,
};

function preview(): WorkOrderImportPreviewResponse {
  return {
    file: { name: 'wo.xlsx', sizeBytes: 500, sha256: SHA },
    sheets: [{ name: 'BOQ', rowCount: 5 }],
    sheetName: 'BOQ',
    headerRow: 1,
    columns: ['A', 'B', 'C', 'D', 'E', 'F'].map((letter, index) => ({
      index,
      letter,
      header: ['Code', 'Description', 'Unit', 'Qty', 'Price', 'Work type'][index] ?? '',
    })),
    suggestedMapping: mapping,
    mapping,
    fileIssues: [],
    rows: [
      row(2, 'A-1', '1', [{ code: 'AMOUNT_MISMATCH', severity: 'warning', field: 'amount' }]),
      row(3, 'D-7', '1', [
        { code: 'CODE_REPEATED', severity: 'error', field: 'code', params: { otherRows: '4' } },
      ]),
      row(4, 'D-7', '1', [
        { code: 'CODE_REPEATED', severity: 'error', field: 'code', params: { otherRows: '3' } },
      ]),
      row(5, 'E-5', null, [{ code: 'MISSING_VALUE', severity: 'error', field: 'quantity' }]),
    ],
    summary: {
      rowCount: 4,
      headingCount: 0,
      errorRowCount: 3,
      warningRowCount: 1,
      duplicateCodes: [],
      total: '1',
    },
  };
}

function created(): WorkOrderDetail {
  return { id: NEW_ID } as WorkOrderDetail;
}

async function uploadFile(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(['PK'], 'wo.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await user.upload(await screen.findByLabelText('Excel file (.xlsx)'), file);
  await screen.findByRole('heading', { name: '2. Sheet and columns' });
  return file;
}

describe('ImportWizard', () => {
  beforeEach(() => {
    push.mockReset();
    previewImport.mockReset().mockResolvedValue(preview());
    commitImport.mockReset().mockResolvedValue(created());
    listWorkOrders.mockReset().mockResolvedValue({ items: [] });
    getContractItems
      .mockReset()
      .mockResolvedValue({ contractId: NEW_ID, contractNumber: 'C-1', items: [] });
  });

  it('previews the file with an empty payload and shows the detected mapping and summary', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    const file = await uploadFile(user);

    expect(previewImport).toHaveBeenCalledWith(PROJECT_ID, file, {}, expect.anything());
    expect(screen.getByLabelText(/^Code/)).toHaveValue('0');
    expect(screen.getByLabelText('Sheet')).toHaveValue('BOQ');
    expect(screen.getByTestId('import-total')).toHaveTextContent('1.00');
    const summary = screen.getByRole('region', { name: '3. Summary' });
    expect(within(summary).getByText('Rows included').nextSibling).toHaveTextContent('4');
    // Issue messages are translated, with the server's params filled in.
    expect(
      screen.getByText(/The code is repeated in rows 4; an item appears once/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The code is repeated in rows 3; an item appears once/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Missing value: Quantity/)).toBeInTheDocument();
    // No duplicate-decision step for work orders (ADR-028).
    expect(screen.queryByLabelText('Keep all as separate lines')).not.toBeInTheDocument();
  });

  it('words the contract-matching issues with the contract value and the available quantity', async () => {
    previewImport.mockResolvedValue({
      ...preview(),
      rows: [
        row(2, 'X-1', '1', [{ code: 'NOT_IN_CONTRACT', severity: 'error', field: 'code' }]),
        row(3, 'X-2', '1', [
          {
            code: 'CONTRACT_MISMATCH',
            severity: 'error',
            field: 'unitPrice',
            params: { contractValue: '8000.00' },
          },
        ]),
        row(4, 'X-3', '1', [
          {
            code: 'CONTRACT_MISMATCH',
            severity: 'error',
            field: 'workType',
            params: { contractValue: 'civil' },
          },
        ]),
        row(5, 'X-4', '9', [
          {
            code: 'QUANTITY_EXCEEDS_CONTRACT',
            severity: 'error',
            field: 'quantity',
            params: { availableQuantity: '4', contractQuantity: '10', reservedQuantity: '6' },
          },
        ]),
      ],
    });
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    expect(screen.getByText('The code is not in the contract')).toBeInTheDocument();
    expect(screen.getByText('Unit price differs from the contract (8000.00)')).toBeInTheDocument();
    expect(screen.getByText('Work type differs from the contract (Civil)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The quantity is above what is available in the contract (available 4 of 10)',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the commit disabled until errors and the number are resolved', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    const commit = screen.getByRole('button', { name: 'Create the work order' });

    expect(commit).toBeDisabled();
    expect(screen.getByText('Enter the work order number')).toBeInTheDocument();
    expect(
      screen.getByText('Rows with errors are still included: exclude them'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Decide what to do with each repeated code')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Number/), 'WO-77');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    expect(commit).toBeEnabled();
    // The excluded error rows left the total and the included count.
    expect(screen.getByTestId('import-total')).toHaveTextContent('1.00');
  });

  it('commits with the excluded error rows and no accepted duplicates, then opens the new work order', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    const file = await uploadFile(user);

    await user.type(screen.getByLabelText(/^Number/), 'WO-77');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    await user.click(screen.getByRole('button', { name: 'Create the work order' }));

    await waitFor(() => expect(commitImport).toHaveBeenCalledTimes(1));
    const [projectId, sentFile, payload] = commitImport.mock.calls[0] as [string, File, unknown];
    expect(projectId).toBe(PROJECT_ID);
    expect(sentFile).toBe(file);
    expect(payload).toMatchObject({
      fileSha256: SHA,
      sheetName: 'BOQ',
      headerRow: 1,
      mapping,
      excludedRowNumbers: [3, 4, 5],
      acceptedDuplicateCodes: [],
      workOrder: { number: 'WO-77' },
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/en/projects/${PROJECT_ID}/work-orders/${NEW_ID}`),
    );
  });

  it.each([
    ['NO_CONTRACT', 'This project has no contract. Create the contract first.'],
    ['CONTRACT_NOT_APPROVED', 'The contract is still a draft. Approve the contract first.'],
  ])('shows the %s reason before upload and offers no file picker', async (reason, text) => {
    getContractItems.mockRejectedValue(new ApiClientError('CONFLICT', 409, { reason }));
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByLabelText('Excel file (.xlsx)')).not.toBeInTheDocument();
  });

  it('points to the existing work order instead of importing a second one', async () => {
    listWorkOrders.mockResolvedValue({ items: [{ id: NEW_ID, number: 'WO-1' }] });
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    expect(await screen.findByText('This project already has a work order.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the work order/ })).toHaveAttribute(
      'href',
      `/en/projects/${PROJECT_ID}/work-orders/${NEW_ID}`,
    );
    expect(screen.queryByLabelText('Excel file (.xlsx)')).not.toBeInTheDocument();
  });

  it('filters the rows by errors and warnings', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    const table = () => screen.getByRole('table', { name: '4. Review the rows' });

    expect(within(table()).getAllByRole('row')).toHaveLength(5); // header + 4
    await user.selectOptions(screen.getByLabelText('Show'), 'errors');
    expect(within(table()).getAllByRole('row')).toHaveLength(4);
    await user.selectOptions(screen.getByLabelText('Show'), 'warnings');
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
  });

  it('re-reads the file with the edited mapping and blocks the commit until then', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);

    await user.selectOptions(screen.getByLabelText('Amount (cross-check)'), '4');
    expect(screen.getByText('Your changes are not applied to the rows yet')).toBeInTheDocument();
    expect(screen.getByText('Re-read the file after changing the settings')).toBeInTheDocument();

    const second = preview();
    second.mapping = { ...mapping, amount: 4 };
    previewImport.mockResolvedValueOnce(second);
    await user.click(screen.getByRole('button', { name: 'Re-read the file with these settings' }));
    await waitFor(() => expect(previewImport).toHaveBeenCalledTimes(2));
    expect(previewImport.mock.calls[1]?.[2]).toMatchObject({
      sheetName: 'BOQ',
      headerRow: 1,
      mapping: { ...mapping, amount: 4 },
    });
  });

  it('explains an IMPORT_INVALID rejection from the server', async () => {
    commitImport.mockRejectedValue(
      new ApiClientError('IMPORT_INVALID', 422, {
        reason: 'FILE_CHANGED',
        fileIssues: [],
        rows: [],
        duplicateCodes: [],
      }),
    );
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    await user.type(screen.getByLabelText(/^Number/), 'WO-79');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    await user.click(screen.getByRole('button', { name: 'Create the work order' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The import was rejected');
    expect(alert).toHaveTextContent('The file is different from the one you reviewed');
    expect(push).not.toHaveBeenCalled();
  });

  it('shows a translated error when the file type is rejected', async () => {
    previewImport.mockRejectedValue(new ApiClientError('UNSUPPORTED_FILE', 415));
    // The browser's picker can be switched to "all files", so the accept filter is not a guard.
    const user = userEvent.setup({ applyAccept: false });
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await user.upload(await screen.findByLabelText('Excel file (.xlsx)'), new File(['x'], 'a.xls'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported file type');
  });

  it('is not available without the write permission', () => {
    renderScreen(<ImportWizard projectId={PROJECT_ID} />, { access: QC_ACCESS });
    expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this');
    expect(screen.queryByLabelText('Excel file (.xlsx)')).not.toBeInTheDocument();
  });
});

const CONTRACT_ID = '4a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const contractDetail = {
  id: CONTRACT_ID,
  status: 'draft',
  version: 5,
  items: [{ id: 'x' }, { id: 'y' }],
};
vi.mock('@/features/contracts/api/contracts-api', () => ({
  getContract: () => Promise.resolve(contractDetail),
}));

function headingRow(rowNumber: number, code: string, title: string): ImportPreviewRow {
  return {
    ...row(rowNumber, code, null),
    kind: 'heading',
    unit: null,
    quantity: null,
    unitPrice: null,
    workType: null,
    raw: {
      code,
      description: title,
      unit: null,
      quantity: null,
      unitPrice: null,
      workType: null,
      amount: null,
    },
  };
}

function boqPreview(): WorkOrderImportPreviewResponse {
  const base = preview();
  const variant = (otherRows: string) => [
    {
      code: 'UNIT_FORM_VARIANT' as const,
      severity: 'warning' as const,
      field: 'unit' as const,
      params: { otherRows },
    },
  ];
  return {
    ...base,
    rows: [
      headingRow(2, '1', 'Civil works'),
      row(3, '1-1', '5', variant('4')),
      row(4, '1-2', '7', variant('3')),
    ],
    summary: {
      rowCount: 3,
      headingCount: 1,
      errorRowCount: 0,
      warningRowCount: 2,
      duplicateCodes: [],
      total: '12',
    },
  };
}

describe('contract BOQ import', () => {
  beforeEach(() => {
    push.mockReset();
    previewContractImport.mockReset().mockResolvedValue(boqPreview());
    commitContractImport.mockReset().mockResolvedValue({ id: CONTRACT_ID });
  });

  it('shows headings as section rows, counts them, and words the unit variant warning', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractImport contractId={CONTRACT_ID} />);
    await uploadFile(user);

    expect(previewContractImport).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.any(File),
      {},
      expect.anything(),
    );
    const table = screen.getByRole('table', { name: '4. Review the rows' });
    const headingCell = within(table).getByText('Civil works').closest('td');
    expect(headingCell).toHaveAttribute('colspan', '6');
    expect(within(table).getByText('Section heading')).toBeInTheDocument();
    // The heading is not an error row.
    const summary = screen.getByRole('region', { name: '3. Summary' });
    expect(within(summary).getByText('Heading rows').nextSibling).toHaveTextContent('1');
    expect(within(summary).getByText('Rows with errors').nextSibling).toHaveTextContent('0');
    expect(screen.getByText('The same unit is typed differently in rows 4')).toBeInTheDocument();
  });

  it('needs the replace confirmation, then sends the version without a work-order header', async () => {
    const user = userEvent.setup();
    renderScreen(<ContractImport contractId={CONTRACT_ID} />);
    await uploadFile(user);

    const commit = screen.getByRole('button', { name: 'Replace the BOQ lines' });
    expect(screen.queryByLabelText(/^Number/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/replaces every existing BOQ line with the file content/),
    ).toBeInTheDocument();
    expect(commit).toBeDisabled();

    await user.click(
      screen.getByLabelText('I confirm that the existing BOQ lines (2) will be replaced'),
    );
    expect(commit).toBeEnabled();
    await user.click(commit);

    await waitFor(() => expect(commitContractImport).toHaveBeenCalledTimes(1));
    const [id, , payload] = commitContractImport.mock.calls[0] as [string, File, unknown];
    expect(id).toBe(CONTRACT_ID);
    expect(payload).toMatchObject({ expectedVersion: 5, excludedRowNumbers: [] });
    expect(payload).not.toHaveProperty('workOrder');
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/en/admin/contracts/${CONTRACT_ID}`));
  });

  it('shows the 409 reason when the contract changed meanwhile', async () => {
    commitContractImport
      .mockReset()
      .mockRejectedValue(new ApiClientError('CONFLICT', 409, { reason: 'STALE_VERSION' }));
    const user = userEvent.setup();
    renderScreen(<ContractImport contractId={CONTRACT_ID} />);
    await uploadFile(user);
    await user.click(
      screen.getByLabelText('I confirm that the existing BOQ lines (2) will be replaced'),
    );
    await user.click(screen.getByRole('button', { name: 'Replace the BOQ lines' }));
    expect(await screen.findByText(/The contract was changed by another user/)).toBeInTheDocument();
  });
});
