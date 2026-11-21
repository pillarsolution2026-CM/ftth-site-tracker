import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { AssignmentsCard } from './project-admin';

type Model = Parameters<typeof AssignmentsCard>[0]['assignments'];

const row = (zoneName: string | null) => ({
  id: '8a000000-0000-4000-8000-000000000001',
  userId: '7a000000-0000-4000-8000-000000000001',
  userEmail: 'o@example.com',
  userDisplayName: 'Omar',
  userIsActive: true,
  role: 'supervisor' as const,
  zoneId: null,
  zoneName,
  createdAt: '2026-11-01T00:00:00.000Z',
});

const model = (items: Model['items'] = []): Model => ({
  loading: false,
  items,
  users: [],
  values: { userId: '', role: 'pm' },
  errors: {},
  pending: false,
  error: null,
  removing: false,
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  onRemove: vi.fn(),
});

describe('AssignmentsCard (ADR-054)', () => {
  it('has no zone field and no contractor role', () => {
    renderScreen(<AssignmentsCard assignments={model()} />);
    expect(screen.queryByLabelText('Zone')).not.toBeInTheDocument();
    const options = within(screen.getByLabelText('Role'))
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).toEqual(['pm', 'supervisor', 'qc']);
  });

  it('shows an old zone name only while a row still has one', () => {
    const first = renderScreen(<AssignmentsCard assignments={model([row('Zone 1')])} />);
    expect(screen.getByRole('columnheader', { name: 'Zone' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Zone 1' })).toBeInTheDocument();
    first.unmount();
    renderScreen(<AssignmentsCard assignments={model([row(null)])} />);
    expect(screen.queryByRole('columnheader', { name: 'Zone' })).not.toBeInTheDocument();
  });
});
