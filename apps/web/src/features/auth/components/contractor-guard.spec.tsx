import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@ftth/shared';
import { renderScreen } from '@/test-utils/render';
import { ContractorGuard } from './contractor-guard';

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: '/en/admin/projects' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
}));
const session = vi.hoisted(() => ({ fetchMe: vi.fn() }));
vi.mock('../api/session-client', () => ({
  fetchMe: session.fetchMe,
  login: vi.fn(),
  logout: vi.fn(),
  SessionApiError: class extends Error {},
}));

const me = (overrides: Partial<MeResponse>): MeResponse => ({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  email: 'u@example.com',
  displayName: 'U',
  locale: 'en',
  isAdmin: false,
  memberships: [],
  contractor: null,
  ...overrides,
});
const CONTRACTOR = { id: '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f', name: 'Nile Cables' };

function renderGuard(text: string) {
  return renderScreen(
    <ContractorGuard>
      <p>{text}</p>
    </ContractorGuard>,
  );
}

describe('ContractorGuard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nav.pathname = '/en/admin/projects';
  });

  it('sends a contractor to his page and never renders the admin page', async () => {
    session.fetchMe.mockResolvedValue(me({ contractor: CONTRACTOR }));
    renderGuard('admin page');
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/en/contractor'));
    expect(screen.queryByText('admin page')).not.toBeInTheDocument();
  });

  it('lets a contractor stay on his own page', async () => {
    nav.pathname = '/en/contractor';
    session.fetchMe.mockResolvedValue(me({ contractor: CONTRACTOR }));
    renderGuard('contractor page');
    expect(await screen.findByText('contractor page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('shows admin and PM pages to everyone else', async () => {
    session.fetchMe.mockResolvedValue(me({ isAdmin: true }));
    renderGuard('admin page');
    expect(await screen.findByText('admin page')).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('sends a non-contractor away from the contractor page', async () => {
    nav.pathname = '/en/contractor';
    session.fetchMe.mockResolvedValue(me({}));
    renderGuard('contractor page');
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/en'));
    expect(screen.queryByText('contractor page')).not.toBeInTheDocument();
  });
});
