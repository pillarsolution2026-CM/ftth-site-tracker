import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/shared/i18n/locale-provider';
import { ProjectShell } from './project-shell';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/en/projects/0f8fad5b-d9cb-469f-a165-70867728950e/cad-files',
}));

let me: MeResponse;
vi.mock('@/features/auth/api/queries', () => ({
  useMeQuery: () => ({ data: me, error: null, isPending: false }),
  useLogoutMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1f8fad5b-d9cb-469f-a165-70867728950e';

function user(overrides: Partial<MeResponse>): MeResponse {
  return {
    id: 'b3b5c5a2-1f0e-4c5e-8a4b-6d2f9a7e1c10',
    email: 'u@example.com',
    displayName: 'U',
    locale: 'en',
    isAdmin: false,
    memberships: [],
    ...overrides,
  };
}

const member = (projectId: string, projectName: string, role: 'pm' | 'qc' | 'contractor') => ({
  projectId,
  projectName,
  role,
  zoneIds: [],
});

function renderShell(projectId = P1) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LocaleProvider locale="en">
        <ProjectShell projectId={projectId}>
          <p>content</p>
        </ProjectShell>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('ProjectShell', () => {
  beforeEach(() => push.mockReset());

  it('shows both sections to a project manager and marks the current one', () => {
    me = user({ memberships: [member(P1, 'Cairo', 'pm')] });
    renderShell();
    expect(screen.getByRole('link', { name: 'Work orders' })).toHaveAttribute(
      'href',
      `/en/projects/${P1}/work-orders`,
    );
    expect(screen.getByRole('link', { name: 'CAD files' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('shows the sections of the current project role only (contractor sees none)', () => {
    me = user({ memberships: [member(P1, 'Cairo', 'pm'), member(P2, 'Giza', 'contractor')] });
    renderShell(P2);
    expect(screen.queryByRole('link', { name: 'Work orders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CAD files' })).not.toBeInTheDocument();
  });

  it('refuses a project the user is not a member of', () => {
    me = user({ memberships: [member(P1, 'Cairo', 'pm')] });
    renderShell(P2);
    expect(screen.getByRole('alert')).toHaveTextContent('You are not a member of this project');
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('switches project and keeps the current section', async () => {
    me = user({ memberships: [member(P1, 'Cairo', 'pm'), member(P2, 'Giza', 'qc')] });
    renderShell();
    await userEvent.setup().selectOptions(screen.getByLabelText('Project'), P2);
    expect(push).toHaveBeenCalledWith(`/en/projects/${P2}/cad-files`);
  });
});
