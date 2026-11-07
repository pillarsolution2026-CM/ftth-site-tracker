import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import {
  CONTRACTOR_2_ID,
  ITEM_1,
  ITEM_2,
  LINE_1,
  REGISTRATION_ID,
  contractor,
  projectContractors,
} from '@/test-utils/contractors';
import { ProjectContractorsSection } from './project-contractors-section';

const api = vi.hoisted(() => ({
  getAdminProjectContractors: vi.fn(),
  listContractors: vi.fn(),
  registerContractor: vi.fn(),
  removeRegistration: vi.fn(),
  updateContractorLine: vi.fn(),
  removeContractorLine: vi.fn(),
  addContractorPrice: vi.fn(),
}));
vi.mock('../api/contractors-api', () => api);

/** Numbers and codes are isolated with direction marks; compare the words. */
const plain = (text: string | null) => (text ?? '').replace(/[⁦-⁩]/g, '');

const second = contractor({ id: CONTRACTOR_2_ID, name: 'Delta Telecom' });

async function openForm() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Register a subcontractor' }));
  return user;
}

describe('ProjectContractorsSection (admin)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getAdminProjectContractors.mockResolvedValue(projectContractors());
    api.listContractors.mockResolvedValue({ items: [contractor(), second] });
    api.registerContractor.mockResolvedValue(undefined);
    api.removeRegistration.mockResolvedValue(undefined);
    api.updateContractorLine.mockResolvedValue(undefined);
    api.removeContractorLine.mockResolvedValue(undefined);
    api.addContractorPrice.mockResolvedValue(undefined);
  });

  it('lists the registration with its lines, price history and the exact total', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const table = await screen.findByRole('table', { name: 'Lines of Nile Cables' });
    const row = within(within(table).getAllByRole('row')[1] as HTMLElement);
    expect(row.getByText('C-001').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(row.getByText('Trenching')).toBeInTheDocument();
    expect(row.getByText('100.00')).toBeInTheDocument(); // contract price
    expect(row.getByText('10')).toBeInTheDocument(); // contractor quantity
    expect(row.getAllByText('90.50')).toHaveLength(2); // current price and history
    expect(row.getByText('2026-11-01')).toBeInTheDocument(); // history
    expect(row.getByText('80.00')).toBeInTheDocument();
    // 10 × 90.5, as an exact decimal
    expect(screen.getByText(/Total for this subcontractor/)).toHaveTextContent('905.00 EGP');
    // registration date in the header, and the first price date in the history
    expect(screen.getAllByText('2026-11-01', { selector: 'bdi' })).toHaveLength(2);
  });

  it('explains that a work order is needed first when there is none', async () => {
    api.getAdminProjectContractors.mockResolvedValue(
      projectContractors({ workOrderId: null, registrations: [], availability: [] }),
    );
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    expect(await screen.findByText(/no work order yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to work orders' })).toHaveAttribute(
      'href',
      `/en/projects/${PROJECT_ID}/work-orders`,
    );
    expect(screen.queryByRole('button', { name: 'Register a subcontractor' })).toBeNull();
  });

  it('disables lines that cannot be given, with the reason, and links to the contractor list', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    await openForm();
    const legacy = screen.getByRole('checkbox', { name: 'Give line OLD-1' });
    expect(legacy).toBeDisabled();
    expect(screen.getByText('Legacy line: cannot be given to a subcontractor')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Give line C-001' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Add a new subcontractor' })).toHaveAttribute(
      'href',
      '/en/admin/contractors',
    );
    // The contractor already on the work order cannot be picked again.
    expect(screen.getByRole('option', { name: 'Nile Cables (already registered)' })).toBeDisabled();
  });

  it('blocks saving until the rules hold: a line, quantity within the available, price within the contract', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = await openForm();
    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });

    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(screen.getByText('Choose at least one line')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Give line C-001' }));
    // The contract price is proposed.
    expect(screen.getByLabelText('Price (C-001)')).toHaveValue('100');
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(
      screen.getByText('Enter a quantity above 0 with at most 4 decimal places'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('Quantity (C-001)'), '40.0001');
    await user.clear(screen.getByLabelText('Price (C-001)'));
    await user.type(screen.getByLabelText('Price (C-001)'), '100.5');
    await user.click(screen.getByRole('button', { name: 'Register' }));
    expect(plain(screen.getByText(/above what is available/).textContent)).toBe(
      'The quantity is above what is available: 40',
    );
    expect(plain(screen.getByText(/above the contract price/).textContent)).toBe(
      'The price is above the contract price: 100',
    );
    expect(api.registerContractor).not.toHaveBeenCalled();
  });

  it('saves a valid registration with exact decimal strings', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = await openForm();
    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Give line C-001' }));
    await user.type(screen.getByLabelText('Quantity (C-001)'), '40');
    await user.click(screen.getByRole('checkbox', { name: 'Give line C-002' }));
    await user.type(screen.getByLabelText('Quantity (C-002)'), '25.5');
    await user.clear(screen.getByLabelText('Price (C-002)'));
    await user.type(screen.getByLabelText('Price (C-002)'), '11.25');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    expect(api.registerContractor).toHaveBeenCalledWith(PROJECT_ID, {
      contractorId: CONTRACTOR_2_ID,
      registeredOn: '2026-11-07',
      lines: [
        { workOrderItemId: ITEM_1, quantity: '40', unitPrice: '100' },
        { workOrderItemId: ITEM_2, quantity: '25.5', unitPrice: '11.25' },
      ],
    });
    // The form closes on success.
    expect(await screen.findByRole('button', { name: 'Register a subcontractor' })).toBeVisible();
  });

  it('shows a server 409 in words with its numbers', async () => {
    api.registerContractor.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        workOrderItemId: ITEM_1,
        code: 'C-001',
        workOrderQuantity: '1050',
        reservedQuantity: '10',
        requestedQuantity: '1040',
        availableQuantity: '1040.5',
      }),
    );
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = await openForm();
    await user.selectOptions(screen.getByLabelText('Subcontractor'), CONTRACTOR_2_ID);
    fireEvent.change(screen.getByLabelText('Registration date'), {
      target: { value: '2026-11-07' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Give line C-001' }));
    await user.type(screen.getByLabelText('Quantity (C-001)'), '40');
    await user.click(screen.getByRole('button', { name: 'Register' }));
    const alert = await screen.findByRole('alert');
    expect(plain(alert.textContent)).toContain(
      'The quantity is above what is available in the work order for item C-001: requested 1,040, available 1,040.5 (work order 1,050, reserved 10).',
    );
  });

  it('adds a dated price: refuses a date that is not after the latest, then saves', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a dated price C-001' }));
    fireEvent.change(screen.getByLabelText('Price from (C-001)'), {
      target: { value: '2026-11-05' },
    });
    await user.type(screen.getByLabelText('New price (C-001)'), '95');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain(screen.getByText(/must be after the latest price date/).textContent)).toBe(
      'The date must be after the latest price date: 2026-11-05',
    );
    expect(api.addContractorPrice).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Price from (C-001)'), {
      target: { value: '2026-11-10' },
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.addContractorPrice).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, LINE_1, {
      effectiveFrom: '2026-11-10',
      unitPrice: '95',
    });
  });

  it('shows the server answer when the price is above the contract', async () => {
    api.addContractorPrice.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'PRICE_EXCEEDS_CONTRACT',
        code: 'C-001',
        contractPrice: '100',
        requestedPrice: '99',
      }),
    );
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a dated price C-001' }));
    fireEvent.change(screen.getByLabelText('Price from (C-001)'), {
      target: { value: '2026-11-10' },
    });
    await user.type(screen.getByLabelText('New price (C-001)'), '99');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain((await screen.findByRole('alert')).textContent)).toContain(
      'The price is above the contract price for item C-001: requested 99, contract price 100.',
    );
  });

  it('edits a quantity, capped by the available plus the line own quantity', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit quantity C-001' }));
    const input = screen.getByLabelText('New quantity (C-001)');
    expect(input).toHaveValue('10');
    await user.clear(input);
    await user.type(input, '50.5'); // available 40 + own 10 = 50
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain(screen.getByText(/above what is available/).textContent)).toBe(
      'The quantity is above what is available: 50',
    );
    await user.clear(input);
    await user.type(input, '50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateContractorLine).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, LINE_1, {
      quantity: '50',
    });
  });

  it('removes a line and a registration only after the admin confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove line C-001' }));
    expect(api.removeContractorLine).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove line C-001' }));
    expect(api.removeContractorLine).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, LINE_1);

    await user.click(screen.getByRole('button', { name: 'Remove registration Nile Cables' }));
    expect(api.removeRegistration).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID);
    expect(confirm).toHaveBeenCalledTimes(3);
    confirm.mockRestore();
  });
});
