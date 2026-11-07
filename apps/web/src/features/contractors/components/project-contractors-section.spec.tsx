import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import {
  LINE_1,
  LINE_BOX,
  REGISTRATION_ID,
  SCOPE_BOX,
  contractorLine,
  projectContractors,
  registration,
  scopedProject,
} from '@/test-utils/contractors';
import { ProjectContractorsSection } from './project-contractors-section';

const api = vi.hoisted(() => ({
  getAdminProjectContractors: vi.fn(),
  listContractors: vi.fn(),
  removeRegistration: vi.fn(),
  updateContractorLine: vi.fn(),
  removeContractorLine: vi.fn(),
  addContractorPrice: vi.fn(),
}));
vi.mock('../api/contractors-api', () => api);

/** Numbers and codes are isolated with direction marks; compare the words. */
const plain = (text: string | null) => (text ?? '').replace(/[⁦-⁩]/g, '');

const twoLines = () =>
  projectContractors({
    registrations: [
      registration({
        lines: [
          contractorLine(),
          contractorLine({
            id: '6a000000-0000-4000-8000-000000000002',
            code: 'C-002',
            quantity: '5',
          }),
        ],
      }),
    ],
  });

describe('ProjectContractorsSection (admin)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getAdminProjectContractors.mockResolvedValue(projectContractors());
    api.listContractors.mockResolvedValue({ items: [] });
    api.removeRegistration.mockResolvedValue(undefined);
    api.updateContractorLine.mockResolvedValue(projectContractors());
    api.removeContractorLine.mockResolvedValue(undefined);
    api.addContractorPrice.mockResolvedValue(projectContractors());
  });

  it('lists the registration with its lines, price history, files and the exact total', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const table = await screen.findByRole('table', { name: 'Lines of Nile Cables' });
    const row = within(within(table).getAllByRole('row')[1] as HTMLElement);
    expect(row.getByText('C-001').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(row.getByText('Trenching')).toBeInTheDocument();
    expect(row.getByText('100.00')).toBeInTheDocument(); // contract price
    expect(row.getByText('10')).toBeInTheDocument(); // contractor quantity
    expect(row.getAllByText('90.50')).toHaveLength(2); // current price and history
    expect(row.getByText('80.00')).toBeInTheDocument();
    // 10 × 90.5, as an exact decimal
    expect(screen.getByText(/Total for this subcontractor/)).toHaveTextContent('905.00 EGP');
    // The uploaded sheet is listed.
    const files = screen.getByRole('region', { name: 'Uploaded files' });
    expect(within(files).getByText('nile-cables.xlsx')).toBeInTheDocument();
  });

  it('shows each line scope, «whole line» when empty, with the per-line summary', async () => {
    api.getAdminProjectContractors.mockResolvedValue(scopedProject());
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const table = await screen.findByRole('table', { name: 'Lines of Nile Cables' });
    const rows = within(table).getAllByRole('row');
    const whole = within(rows[1] as HTMLElement);
    expect(whole.getByText(/Whole line/)).toBeInTheDocument();
    expect(plain(whole.getByText(/Given whole/).textContent)).toBe('Given whole · price left 9.50');
    const box = within(rows[2] as HTMLElement);
    expect(box.getByText(new RegExp(SCOPE_BOX))).toBeInTheDocument();
    expect(plain(box.getByText(/Split/).textContent)).toBe('Split: 3 scopes · price left 0.00');
  });

  it('has no manual line entry: registering and uploading more are links to the upload page', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const register = await screen.findByRole('link', { name: 'Register a subcontractor' });
    expect(register).toHaveAttribute('href', `/en/admin/projects/${PROJECT_ID}/contractors/import`);
    expect(screen.getByRole('link', { name: 'Upload more lines for Nile Cables' })).toHaveAttribute(
      'href',
      `/en/admin/projects/${PROJECT_ID}/contractors/import?registrationId=${REGISTRATION_ID}`,
    );
    expect(screen.queryByRole('button', { name: /Add line/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
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
    expect(screen.queryByRole('link', { name: 'Register a subcontractor' })).toBeNull();
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

  it('refuses a price above what the scopes leave: price room plus this scope highest price', async () => {
    api.getAdminProjectContractors.mockResolvedValue(scopedProject());
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a dated price 2-12-4-8' }));
    fireEvent.change(screen.getByLabelText('Price from (2-12-4-8)'), {
      target: { value: '2026-11-10' },
    });
    // The scopes already add up to 30: this scope (12) may not go above 12.
    await user.type(screen.getByLabelText('New price (2-12-4-8)'), '13');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain(screen.getByText(/most allowed for this scope/).textContent)).toBe(
      'The price is above the most allowed for this scope: 12',
    );
    expect(api.addContractorPrice).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('New price (2-12-4-8)'));
    await user.type(screen.getByLabelText('New price (2-12-4-8)'), '12');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.addContractorPrice).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, LINE_BOX, {
      effectiveFrom: '2026-11-10',
      unitPrice: '12',
    });
  });

  it('shows the server maxAllowedPrice when the scope prices pass the contract price', async () => {
    api.addContractorPrice.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'PRICE_EXCEEDS_CONTRACT',
        code: 'C-001',
        contractPrice: '100',
        otherScopesPrice: '30',
        maxAllowedPrice: '70',
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
      'The scope prices add up to more than the contract price 100 for item C-001: the most allowed is 70 (other scopes 30, requested 99).',
    );
  });

  it('edits a quantity, capped by what is free for the scope plus the line own quantity', async () => {
    api.getAdminProjectContractors.mockResolvedValue(scopedProject());
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit quantity 2-12-4-8' }));
    const input = screen.getByLabelText('New quantity (2-12-4-8)');
    expect(input).toHaveValue('20');
    await user.clear(input);
    await user.type(input, '100.5'); // scope available 80 + own 20 = 100
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain(screen.getByText(/above what is available/).textContent)).toBe(
      'The quantity is above what is available: 100',
    );
    await user.clear(input);
    await user.type(input, '100');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateContractorLine).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, LINE_BOX, {
      quantity: '100',
    });
  });

  it('shows the server answer about the scope when the quantity is too high', async () => {
    api.updateContractorLine.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, {
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        code: '2-12-4-8',
        scope: SCOPE_BOX,
        workOrderQuantity: '100',
        reservedQuantity: '90',
        requestedQuantity: '50',
        availableQuantity: '10',
      }),
    );
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit quantity C-001' }));
    await user.clear(screen.getByLabelText('New quantity (C-001)'));
    await user.type(screen.getByLabelText('New quantity (C-001)'), '20');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(plain((await screen.findByRole('alert')).textContent)).toContain(
      `above what is available for scope ${SCOPE_BOX} of item 2-12-4-8: requested 50, available 10 (work order 100, reserved 90).`,
    );
  });

  it('cannot remove the only line, and shows LAST_LINE if the server says so', async () => {
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    expect(await screen.findByRole('button', { name: 'Remove line C-001' })).toBeDisabled();
    expect(
      screen.getByText('The last line cannot be removed; remove the whole registration'),
    ).toBeInTheDocument();
  });

  it('shows the server LAST_LINE answer in words', async () => {
    api.getAdminProjectContractors.mockResolvedValue(twoLines());
    api.removeContractorLine.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'LAST_LINE' }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen(<ProjectContractorsSection projectId={PROJECT_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove line C-002' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The last line cannot be removed. Remove the whole registration instead.',
    );
  });

  it('removes a line and a registration only after the admin confirms', async () => {
    api.getAdminProjectContractors.mockResolvedValue(twoLines());
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
