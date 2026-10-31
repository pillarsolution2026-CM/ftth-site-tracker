import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractSummary, Project } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ProjectsAdminView, type ProjectsAdminViewProps } from './projects-admin';

const CONTRACT_ID = '4a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const ISO = '2026-10-31T08:00:00.000Z';

const contract: ContractSummary = {
  id: CONTRACT_ID,
  number: 'C-1',
  name: 'FTTH Cairo',
  client: 'Telecom Co',
  currency: 'EGP',
  startsOn: null,
  durationDays: null,
  status: 'approved',
  approvedAt: ISO,
  itemCount: 3,
  total: '10',
  projectCount: 1,
  version: 4,
  createdAt: ISO,
  updatedAt: ISO,
};

const project = (overrides: Partial<Project> = {}): Project => ({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'Shubra',
  client: 'Telecom Co',
  crsEpsg: 32636,
  currency: 'EGP',
  locale: 'ar',
  contractId: CONTRACT_ID,
  ...overrides,
});

function props(overrides: Partial<ProjectsAdminViewProps> = {}): ProjectsAdminViewProps {
  return {
    loading: false,
    listError: null,
    items: [project(), project({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', contractId: null })],
    contracts: [contract],
    suggestions: { crsEpsg: ['32636'] },
    values: { name: '', contractId: '', crsEpsg: '32636', locale: 'ar' },
    errors: {},
    pending: false,
    submitError: null,
    onChange: vi.fn(),
    onSubmit: vi.fn((event: { preventDefault: () => void }) => event.preventDefault()),
    ...overrides,
  };
}

describe('ProjectsAdminView', () => {
  it('chooses a contract (number, name, client, currency) instead of typing client and currency', () => {
    renderScreen(<ProjectsAdminView {...props()} />);
    const form = screen
      .getByRole('button', { name: 'Create work order / project' })
      .closest('form');
    const select = within(form as HTMLElement).getByLabelText('Contract');
    expect(
      within(select).getByRole('option', { name: 'C-1 — FTTH Cairo — Telecom Co — EGP' }),
    ).toBeInTheDocument();
    expect(within(form as HTMLElement).queryByLabelText('Client')).not.toBeInTheDocument();
    expect(within(form as HTMLElement).queryByLabelText('Currency')).not.toBeInTheDocument();
  });

  it('reports the chosen contract and shows the contract number in the list', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderScreen(<ProjectsAdminView {...props({ onChange })} />);
    await user.selectOptions(screen.getByLabelText('Contract'), CONTRACT_ID);
    expect(onChange).toHaveBeenCalledWith('contractId', CONTRACT_ID);
    const table = screen.getByRole('table');
    expect(within(table).getByText('C-1')).toBeInTheDocument();
    expect(within(table).getByText('No contract (older work order)')).toBeInTheDocument();
  });

  it('asks for a contract when none is chosen and points to the contracts screen when none exist', () => {
    renderScreen(
      <ProjectsAdminView
        {...props({ contracts: [], errors: { contractId: 'admin.validation.contract' } })}
      />,
    );
    expect(screen.getByText('Choose the contract', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contract')).toHaveAttribute('aria-invalid', 'true');
  });
});
