import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractorAccount } from '@ftth/shared';
import { ApiClientError } from '@/shared/api/bff-client';
import { PROJECT_ID, renderScreen } from '@/test-utils/render';
import { ContractorAccounts } from './contractor-accounts';

const api = vi.hoisted(() => ({
  listContractorAccounts: vi.fn(),
  createContractorAccount: vi.fn(),
  setContractorAccountActive: vi.fn(),
}));
vi.mock('../api/accounts-api', () => api);

const REGISTRATION_ID = '4c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const CONTRACTOR_ID = '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const account = (overrides: Partial<ContractorAccount> = {}): ContractorAccount => ({
  userId: '7b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f',
  email: 'ali@nile.example',
  displayName: 'Ali',
  locale: 'ar',
  isActive: true,
  createdAt: '2026-11-20T08:00:00.000Z',
  ...overrides,
});

const PASSWORD = 'a-long-initial-password';

function renderSection() {
  return renderScreen(
    <ContractorAccounts
      projectId={PROJECT_ID}
      registrationId={REGISTRATION_ID}
      contractorName="Nile Cables"
    />,
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>, password = PASSWORD) {
  await user.type(screen.getByLabelText('Email'), 'sara@nile.example');
  await user.type(screen.getByLabelText('Name'), 'Sara');
  await user.type(screen.getByLabelText('Initial password'), password);
}

describe('ContractorAccounts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listContractorAccounts.mockResolvedValue({
      contractorId: CONTRACTOR_ID,
      items: [account()],
    });
    api.createContractorAccount.mockResolvedValue(account());
    api.setContractorAccountActive.mockResolvedValue(account({ isActive: false }));
  });

  it('lists the accounts with email, name, language, status and created date', async () => {
    renderSection();
    const table = await screen.findByRole('table', { name: 'Accounts of Nile Cables' });
    const row = within(within(table).getAllByRole('row')[1] as HTMLElement);
    expect(row.getByText('ali@nile.example').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(row.getByText('Ali')).toBeInTheDocument();
    expect(row.getByText('العربية')).toBeInTheDocument();
    expect(row.getByText(/Active/)).toBeInTheDocument();
    expect(row.getByText('2026-11-20').closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(api.listContractorAccounts).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID);
  });

  it('says so when there is no account', async () => {
    api.listContractorAccounts.mockResolvedValue({ contractorId: CONTRACTOR_ID, items: [] });
    renderSection();
    expect(await screen.findByText('No login account yet')).toBeInTheDocument();
  });

  it('creates an account, then clears the form and shows a note without the password', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('table');
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(api.createContractorAccount).toHaveBeenCalledWith(PROJECT_ID, REGISTRATION_ID, {
      email: 'sara@nile.example',
      displayName: 'Sara',
      password: PASSWORD,
      locale: 'ar',
    });
    expect(await screen.findByText(/Account created/)).toBeInTheDocument();
    expect(screen.getByLabelText('Initial password')).toHaveValue('');
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it('rejects a password shorter than 12 characters without calling the server', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('table');
    await fillForm(user, 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText('The password must be 12 to 128 characters'),
    ).toBeInTheDocument();
    expect(api.createContractorAccount).not.toHaveBeenCalled();
  });

  it('explains EMAIL_TAKEN', async () => {
    api.createContractorAccount.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'EMAIL_TAKEN' }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('table');
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('An account with this email already exists')).toBeVisible();
  });

  it('shows the generic text of any other failure', async () => {
    api.createContractorAccount.mockRejectedValue(new ApiClientError('FORBIDDEN', 403));
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('table');
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('You are not allowed to do this')).toBeVisible();
  });

  it('stops an account only after the confirm, and does nothing when it is declined', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSection();
    const stop = await screen.findByRole('button', { name: 'Stop ali@nile.example' });
    await user.click(stop);
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.setContractorAccountActive).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(stop);
    expect(api.setContractorAccountActive).toHaveBeenCalledWith(
      PROJECT_ID,
      REGISTRATION_ID,
      account().userId,
      false,
    );
    confirm.mockRestore();
  });

  it('restarts a stopped account', async () => {
    api.listContractorAccounts.mockResolvedValue({
      contractorId: CONTRACTOR_ID,
      items: [account({ isActive: false })],
    });
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSection();
    expect(await screen.findByText(/Stopped/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restart ali@nile.example' }));
    expect(api.setContractorAccountActive).toHaveBeenCalledWith(
      PROJECT_ID,
      REGISTRATION_ID,
      account().userId,
      true,
    );
  });
});
