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
import { ImportWizard } from './import-wizard';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const previewImport = vi.fn();
const commitImport = vi.fn();
vi.mock('../api/import-api', () => ({
  previewImport: (...args: unknown[]) => previewImport(...args),
  commitImport: (...args: unknown[]) => commitImport(...args),
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
    raw: {
      code,
      description: `Item ${code}`,
      unit: 'm',
      quantity: '1',
      unitPrice: '1',
      amount: null,
    },
    code,
    description: `Item ${code}`,
    unit: 'm',
    quantity: '1',
    unitPrice: '1',
    sheetAmount: null,
    amount,
    issues,
  };
}

const mapping = { code: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4, amount: null };

function preview(): WorkOrderImportPreviewResponse {
  return {
    file: { name: 'wo.xlsx', sizeBytes: 500, sha256: SHA },
    sheets: [{ name: 'BOQ', rowCount: 5 }],
    sheetName: 'BOQ',
    headerRow: 1,
    columns: ['A', 'B', 'C', 'D', 'E'].map((letter, index) => ({
      index,
      letter,
      header: ['Code', 'Description', 'Unit', 'Qty', 'Price'][index] ?? '',
    })),
    suggestedMapping: mapping,
    mapping,
    fileIssues: [],
    rows: [
      row(2, 'A-1', '1'),
      row(3, 'D-7', '1', [
        { code: 'DUPLICATE_CODE', severity: 'warning', field: 'code', params: { otherRows: '4' } },
      ]),
      row(4, 'D-7', '1', [
        { code: 'DUPLICATE_CODE', severity: 'warning', field: 'code', params: { otherRows: '3' } },
      ]),
      row(5, 'E-5', null, [{ code: 'MISSING_VALUE', severity: 'error', field: 'quantity' }]),
    ],
    summary: {
      rowCount: 4,
      errorRowCount: 1,
      warningRowCount: 2,
      duplicateCodes: [{ code: 'D-7', rowNumbers: [3, 4] }],
      total: '3',
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
  await user.upload(screen.getByLabelText('Excel file (.xlsx)'), file);
  await screen.findByRole('heading', { name: '2. Sheet and columns' });
  return file;
}

describe('ImportWizard', () => {
  beforeEach(() => {
    push.mockReset();
    previewImport.mockReset().mockResolvedValue(preview());
    commitImport.mockReset().mockResolvedValue(created());
  });

  it('previews the file with an empty payload and shows the detected mapping and summary', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    const file = await uploadFile(user);

    expect(previewImport).toHaveBeenCalledWith(PROJECT_ID, file, {}, expect.anything());
    expect(screen.getByLabelText(/^Code/)).toHaveValue('0');
    expect(screen.getByLabelText('Sheet')).toHaveValue('BOQ');
    expect(screen.getByTestId('import-total')).toHaveTextContent('3.00');
    const summary = screen.getByRole('region', { name: '3. Summary' });
    expect(within(summary).getByText('Rows included').nextSibling).toHaveTextContent('4');
    // Issue messages are translated, with the server's params filled in.
    expect(screen.getAllByText(/This code is repeated in rows [34]/).length).toBe(2);
    expect(screen.getByText(/Missing value: Quantity/)).toBeInTheDocument();
  });

  it('keeps the commit disabled until errors, duplicates and the number are resolved', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    const commit = screen.getByRole('button', { name: 'Create the work order' });

    expect(commit).toBeDisabled();
    expect(screen.getByText('Enter the work order number')).toBeInTheDocument();
    expect(screen.getByText('Decide what to do with each repeated code')).toBeInTheDocument();
    expect(
      screen.getByText('Rows with errors are still included: exclude them'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Number/), 'WO-77');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    await user.click(screen.getByLabelText('Keep all as separate lines'));
    expect(commit).toBeEnabled();
    // The excluded error row left the total and the included count.
    expect(screen.getByTestId('import-total')).toHaveTextContent('3.00');
  });

  it('commits with excluded rows and the accepted duplicate codes, then opens the new work order', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    const file = await uploadFile(user);

    await user.type(screen.getByLabelText(/^Number/), 'WO-77');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    await user.click(screen.getByLabelText('Keep all as separate lines'));
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
      excludedRowNumbers: [5],
      acceptedDuplicateCodes: ['D-7'],
      workOrder: { number: 'WO-77' },
    });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/en/projects/${PROJECT_ID}/work-orders/${NEW_ID}`),
    );
  });

  it('"exclude the rows of this code" leaves the duplicates out of the commit', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    await user.type(screen.getByLabelText(/^Number/), 'WO-78');
    await user.click(screen.getByLabelText('Exclude rows with errors'));
    await user.click(screen.getByLabelText('Exclude the rows of this code'));
    await user.click(screen.getByRole('button', { name: 'Create the work order' }));

    await waitFor(() => expect(commitImport).toHaveBeenCalled());
    expect(commitImport.mock.calls[0]?.[2]).toMatchObject({
      excludedRowNumbers: [3, 4, 5],
      acceptedDuplicateCodes: [],
    });
  });

  it('filters the rows by errors and warnings', async () => {
    const user = userEvent.setup();
    renderScreen(<ImportWizard projectId={PROJECT_ID} />);
    await uploadFile(user);
    const table = () => screen.getByRole('table', { name: '4. Review the rows' });

    expect(within(table()).getAllByRole('row')).toHaveLength(5); // header + 4
    await user.selectOptions(screen.getByLabelText('Show'), 'errors');
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Show'), 'warnings');
    expect(within(table()).getAllByRole('row')).toHaveLength(3);
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
    await user.click(screen.getByLabelText('Keep all as separate lines'));
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
    await user.upload(screen.getByLabelText('Excel file (.xlsx)'), new File(['x'], 'a.xls'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported file type');
  });

  it('is not available without the write permission', () => {
    renderScreen(<ImportWizard projectId={PROJECT_ID} />, { access: QC_ACCESS });
    expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do this');
    expect(screen.queryByLabelText('Excel file (.xlsx)')).not.toBeInTheDocument();
  });
});
