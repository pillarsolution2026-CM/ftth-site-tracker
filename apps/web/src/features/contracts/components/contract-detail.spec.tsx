import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractDetail as ContractDetailData } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { CONTRACT_ID, contractDetail, pricedItem } from '@/test-utils/contract';
import { ContractDetail } from './contract-detail';

const api = vi.hoisted(() => ({
  getContract: vi.fn(),
  updateContract: vi.fn(),
  addContractItem: vi.fn(),
  updateContractItem: vi.fn(),
  removeContractItem: vi.fn(),
  approveContract: vi.fn(),
  listContracts: vi.fn(),
  createContract: vi.fn(),
  getProjectContract: vi.fn(),
  uploadContractAttachment: vi.fn(),
  deleteContractAttachment: vi.fn(),
  contractAttachmentUrl: (contractId: string, attachmentId: string) =>
    `/api/admin/contracts/${contractId}/attachments/${attachmentId}`,
}));
vi.mock('../api/contracts-api', () => api);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const conflict = (reason: string) => new ApiClientError('CONFLICT', 409, { reason });

function load(detail: ContractDetailData) {
  api.getContract.mockResolvedValue(detail);
}

async function open() {
  renderScreen(<ContractDetail contractId={CONTRACT_ID} />);
  await screen.findByRole('heading', { name: /Contract\s+C-2026-01/ });
  return userEvent.setup();
}

describe('ContractDetail (admin)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    load(contractDetail());
  });

  it('a draft offers add item, add heading, import and approve', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add section heading' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import from Excel' })).toHaveAttribute(
      'href',
      `/en/admin/contracts/${CONTRACT_ID}/import`,
    );
    expect(screen.getByRole('button', { name: 'Approve contract' })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit 1-1' })).toBeInTheDocument();
  });

  it('an approved contract hides every BOQ edit action and shows the approval date', async () => {
    load(contractDetail({ status: 'approved', approvedAt: '2026-10-30T09:00:00.000Z' }));
    await open();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    for (const name of ['Add item', 'Add section heading', 'Approve contract']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Import from Excel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit 1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete 1/ })).not.toBeInTheDocument();
    expect(screen.getByText(/the BOQ is locked/)).toBeInTheDocument();
    expect(screen.getByText('Approved on').nextSibling).toHaveTextContent('2026');
  });

  it('approving asks for a confirmation that explains it is final, then sends the version', async () => {
    api.approveContract.mockResolvedValue(contractDetail({ status: 'approved' }));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Approve contract' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Approve this contract?' });
    expect(within(dialog).getByText(/final and cannot be undone/)).toBeInTheDocument();
    expect(within(dialog).getByText(/locked/)).toBeInTheDocument();
    expect(api.approveContract).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Approve for good' }));
    await waitFor(() => expect(api.approveContract).toHaveBeenCalledWith(CONTRACT_ID, 3));
  });

  it('cancelling the approval sends nothing', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Approve contract' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.approveContract).not.toHaveBeenCalled();
  });

  it.each([
    ['NO_PRICED_ITEMS', 'A contract without priced items cannot be approved'],
    ['STALE_VERSION', 'The contract was changed by another user'],
    ['CONTRACT_APPROVED', 'The contract is approved: BOQ lines cannot be changed'],
  ])('approval 409 %s shows a clear message', async (reason, message) => {
    api.approveContract.mockRejectedValue(conflict(reason));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Approve contract' }));
    await user.click(screen.getByRole('button', { name: 'Approve for good' }));
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
  });

  it('a heading needs only a code: no unit, quantity or price fields', async () => {
    api.addContractItem.mockResolvedValue(contractDetail());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add section heading' }));
    const form = screen.getByRole('form', { name: 'Add section heading' });
    expect(within(form).queryByLabelText('Unit')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Unit price')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Contract quantity')).not.toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('This field is required')).toBeInTheDocument();
    expect(api.addContractItem).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText('Code'), '2');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addContractItem).toHaveBeenCalledTimes(1));
    expect(api.addContractItem.mock.calls[0]?.[1]).toEqual({
      item: { kind: 'heading', code: '2', description: null },
      acceptDuplicateCode: false,
      expectedVersion: 3,
    });
  });

  it('adds a priced item and asks before keeping a repeated code', async () => {
    api.addContractItem.mockResolvedValue(contractDetail());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    const form = screen.getByRole('form', { name: 'Add item' });
    await user.type(within(form).getByLabelText('Code'), '1-1');
    await user.type(within(form).getByLabelText('Description'), 'Trench');
    await user.type(within(form).getByLabelText('Unit'), 'm');
    await user.type(within(form).getByLabelText('Contract quantity'), '0');
    await user.type(within(form).getByLabelText('Unit price'), '0');
    await user.selectOptions(within(form).getByLabelText('Work type'), 'civil');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    expect(within(form).getByText(/Code 1-1 already exists on lines 2/)).toBeInTheDocument();
    expect(api.addContractItem).not.toHaveBeenCalled();
    await user.click(within(form).getByRole('button', { name: 'Keep as a separate line' }));
    await waitFor(() => expect(api.addContractItem).toHaveBeenCalledTimes(1));
    expect(api.addContractItem.mock.calls[0]?.[1]).toMatchObject({
      item: { kind: 'item', code: '1-1', quantity: '0', unitPrice: '0', workType: 'civil' },
      acceptDuplicateCode: true,
      expectedVersion: 3,
    });
  });

  it.each([
    ['DUPLICATE_CODE', 'This code already exists in the contract'],
    ['LINE_TAKEN', 'This line number is already used'],
    ['STALE_VERSION', 'The contract was changed by another user'],
  ])('add line 409 %s shows a clear message', async (reason, message) => {
    api.addContractItem.mockRejectedValue(conflict(reason));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add section heading' }));
    await user.type(screen.getByLabelText('Code'), '9');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
  });

  it('deleting a line asks first and sends the version', async () => {
    api.removeContractItem.mockResolvedValue(contractDetail());
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Delete 1-1-1' }));
    expect(api.removeContractItem).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Delete this line?' });
    await user.click(within(group).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.removeContractItem).toHaveBeenCalledTimes(1));
    expect(api.removeContractItem.mock.calls[0]?.[0]).toBe(CONTRACT_ID);
    expect(api.removeContractItem.mock.calls[0]?.[2]).toBe(3);
  });

  it('edits the header after approval, never the currency, and sends expectedVersion', async () => {
    load(contractDetail({ status: 'approved', approvedAt: '2026-10-30T09:00:00.000Z' }));
    api.updateContract.mockResolvedValue(contractDetail({ status: 'approved', name: 'New name' }));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit contract details' }));

    expect(screen.getByLabelText('Currency')).toHaveAttribute('readonly');
    const name = screen.getByLabelText('Contract name');
    await user.clear(name);
    await user.type(name, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateContract).toHaveBeenCalledTimes(1));
    const body = api.updateContract.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'New name', number: 'C-2026-01', expectedVersion: 3 });
    expect(body).not.toHaveProperty('currency');
  });

  it.each([
    ['STALE_VERSION', 'The contract was changed by another user'],
    ['DUPLICATE_NUMBER', 'This contract number is already used'],
  ])('header save 409 %s shows a clear message', async (reason, message) => {
    api.updateContract.mockRejectedValue(conflict(reason));
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Edit contract details' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
  });

  it('shows duplicate-code warnings like the work orders', async () => {
    load(
      contractDetail({
        items: [pricedItem(1, 'A-1'), pricedItem(2, 'A-1')],
        duplicateCodes: [{ code: 'A-1', lineNos: [1, 2] }],
      }),
    );
    await open();
    expect(screen.getByText('Code A-1 on lines 1, 2')).toBeInTheDocument();
  });

  it('lists the PDF attachments with upload and download', async () => {
    load(
      contractDetail({
        attachments: [
          {
            id: '9a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f',
            contractId: CONTRACT_ID,
            kind: 'document',
            fileName: 'signed.pdf',
            contentType: 'application/pdf',
            sizeBytes: 2048,
            sha256: 'a'.repeat(64),
            uploadedById: null,
            createdAt: '2026-10-31T08:00:00.000Z',
          },
        ],
      }),
    );
    await open();
    expect(screen.getByRole('link', { name: 'signed.pdf' })).toHaveAttribute(
      'href',
      `/api/admin/contracts/${CONTRACT_ID}/attachments/9a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f`,
    );
    expect(screen.getByLabelText('Upload a PDF')).toBeInTheDocument();
  });
});
