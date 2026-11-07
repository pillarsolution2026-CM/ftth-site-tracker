import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { CONTRACTOR_ID, contractor } from '@/test-utils/contractors';
import { ContractorsAdmin } from './contractors-admin';

const api = vi.hoisted(() => ({
  listContractors: vi.fn(),
  createContractor: vi.fn(),
  updateContractor: vi.fn(),
}));
vi.mock('../api/contractors-api', () => api);

describe('ContractorsAdmin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listContractors.mockResolvedValue({
      items: [
        contractor(),
        contractor({
          id: 'x',
          name: 'Delta Telecom',
          taxCard: 'TX-9',
          commercialRegister: null,
          workOrderCount: 0,
        }),
      ],
    });
    api.createContractor.mockResolvedValue(undefined);
    api.updateContractor.mockResolvedValue(undefined);
  });

  it('lists name, contact person, phone, register, tax card and work-order count', async () => {
    renderScreen(<ContractorsAdmin />);
    const table = await screen.findByRole('table', { name: 'All subcontractors' });
    const rows = within(table).getAllByRole('row');
    const first = within(rows[1] as HTMLElement);
    expect(first.getByText('Nile Cables')).toBeInTheDocument();
    expect(first.getByText('Hassan Ali')).toBeInTheDocument();
    expect(first.getByText('+20 100 123 4567').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(first.getByText('CR-123')).toBeInTheDocument();
    expect(first.getByText('2')).toBeInTheDocument();
    const second = within(rows[2] as HTMLElement);
    expect(second.getByText('TX-9')).toBeInTheDocument();
    expect(second.getByText('—')).toBeInTheDocument();
  });

  it('requires name, contact person and phone, and sends nothing until they are valid', async () => {
    renderScreen(<ContractorsAdmin />);
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Create subcontractor' }));
    expect(screen.getAllByText('This field is required')).toHaveLength(3);
    expect(api.createContractor).not.toHaveBeenCalled();
  });

  it('creates a contractor; optional fields are sent as null', async () => {
    renderScreen(<ContractorsAdmin />);
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.type(screen.getByLabelText('Name'), '  Sphinx Fiber ');
    await user.type(screen.getByLabelText('Contact person'), 'Mona Said');
    await user.type(screen.getByLabelText('Phone'), '010 2345 6789');
    await user.click(screen.getByRole('button', { name: 'Create subcontractor' }));
    expect(api.createContractor).toHaveBeenCalledWith({
      name: 'Sphinx Fiber',
      contactName: 'Mona Said',
      contactPhone: '010 2345 6789',
      commercialRegister: null,
      taxCard: null,
    });
    expect(await screen.findByText('Subcontractor created')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('says in words when the name is already used', async () => {
    api.createContractor.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'CONTRACTOR_NAME_TAKEN' }),
    );
    renderScreen(<ContractorsAdmin />);
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.type(screen.getByLabelText('Name'), 'Nile Cables');
    await user.type(screen.getByLabelText('Contact person'), 'X');
    await user.type(screen.getByLabelText('Phone'), '0100000000');
    await user.click(screen.getByRole('button', { name: 'Create subcontractor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This name is already used by another subcontractor.',
    );
  });

  it('edits a contractor with its version and can clear an optional field', async () => {
    renderScreen(<ContractorsAdmin />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Nile Cables' }));
    expect(screen.getByRole('heading', { name: 'Edit subcontractor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toHaveValue('+20 100 123 4567');
    await user.clear(screen.getByLabelText(/Commercial register/));
    await user.clear(screen.getByLabelText('Contact person'));
    await user.type(screen.getByLabelText('Contact person'), 'Omar Fathy');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateContractor).toHaveBeenCalledWith(CONTRACTOR_ID, {
      name: 'Nile Cables',
      contactName: 'Omar Fathy',
      contactPhone: '+20 100 123 4567',
      commercialRegister: null,
      taxCard: null,
      expectedVersion: 1,
    });
    expect(await screen.findByText('Changes saved')).toBeInTheDocument();
  });
});
