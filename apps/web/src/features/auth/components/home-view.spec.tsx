import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MeResponse, Project } from '@ftth/shared';
import { renderScreen } from '@/test-utils/render';
import { HomeView } from './home-view';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const project = (id: string, name: string): Project => ({
  id,
  name,
  client: 'C',
  crsEpsg: 32636,
  currency: 'EGP',
  locale: 'ar',
  contractId: null,
});
const me = (overrides: Partial<MeResponse>): MeResponse => ({
  id: A,
  email: 'u@example.com',
  displayName: 'U',
  locale: 'en',
  isAdmin: false,
  memberships: [],
  ...overrides,
});
const base = { loading: false, failureCode: null, loggingOut: false, onLogout: () => {} };

describe('HomeView', () => {
  it('shows an admin every project, each linking to its page, and the admin link', () => {
    renderScreen(
      <HomeView
        {...base}
        me={me({ isAdmin: true })}
        allProjects={[project(A, 'Alpha'), project(B, 'Beta')]}
        allProjectsLoading={false}
      />,
    );
    expect(screen.getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      `/en/projects/${A}`,
    );
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute('href', `/en/projects/${B}`);
    expect(screen.getByRole('link', { name: 'Manage projects and users' })).toBeInTheDocument();
  });

  it('falls back to memberships when the admin list is unavailable', () => {
    renderScreen(
      <HomeView
        {...base}
        me={me({
          isAdmin: true,
          memberships: [{ projectId: A, projectName: 'Alpha', role: 'pm', zoneIds: [] }],
        })}
        allProjects={null}
        allProjectsLoading={false}
      />,
    );
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('shows a non-admin only their memberships and no admin link', () => {
    renderScreen(
      <HomeView
        {...base}
        me={me({
          memberships: [{ projectId: B, projectName: 'Beta', role: 'supervisor', zoneIds: [A] }],
        })}
        allProjects={null}
        allProjectsLoading={false}
      />,
    );
    expect(screen.getByRole('link', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.getByText('Supervisor')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Manage projects and users' })).toBeNull();
  });
});
