import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementGroupsResponse } from '@ftth/shared';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { ElementGroupsAdmin } from './element-groups-admin';

const api = vi.hoisted(() => ({ getElementGroups: vi.fn(), replaceElementGroups: vi.fn() }));
vi.mock('../api/element-groups-api', () => api);

const response = (overrides: Partial<ElementGroupsResponse> = {}): ElementGroupsResponse => ({
  elements: [
    { element: 'route_general', mains: ['حفر', 'بنادل'], version: 3 },
    { element: 'route_secondary', mains: ['حفر'], version: 1 },
    { element: 'cabinet', mains: ['كابينه'], version: 1 },
    { element: 'box', mains: ['BOX'], version: 1 },
    { element: 'room', mains: ['غرف'], version: 1 },
    { element: 'joint', mains: ['لحام في الغرف'], version: 1 },
    { element: 'planning', mains: ['As Built', 'GIS', 'AS PLAN'], version: 1 },
  ],
  unlinked: [{ main: 'أعمال خاصة', lineCount: 4 }],
  knownMains: ['أعمال خاصة', 'بنادل', 'حفر'],
  ...overrides,
});

const GENERAL = 'Route on the General drawing';

async function generalCard() {
  return within(await screen.findByRole('group', { name: GENERAL }));
}

describe('ElementGroupsAdmin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getElementGroups.mockResolvedValue(response());
    api.replaceElementGroups.mockResolvedValue({});
  });

  it('shows one card per element with its groups in order', async () => {
    renderScreen(<ElementGroupsAdmin />);
    const route = await generalCard();
    const items = route.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('حفر');
    expect(items[1]).toContain('بنادل');
    expect(screen.getAllByRole('group')).toHaveLength(7);
    expect(screen.getByRole('group', { name: 'Planning button' })).toBeInTheDocument();
  });

  it('warns about unlinked groups with their line counts', async () => {
    renderScreen(<ElementGroupsAdmin />);
    expect(await screen.findByText('Groups not linked to any element')).toBeInTheDocument();
    const warning = screen
      .getByText('أعمال خاصة', { selector: 'span' })
      .closest('li') as HTMLElement;
    expect(within(warning).getByText('4 lines').closest('bdi')).toHaveAttribute('dir', 'ltr');
  });

  it('shows no warning when everything is linked', async () => {
    api.getElementGroups.mockResolvedValue(response({ unlinked: [] }));
    renderScreen(<ElementGroupsAdmin />);
    await screen.findByRole('group', { name: 'Box' });
    expect(screen.queryByText('Groups not linked to any element')).not.toBeInTheDocument();
  });

  it('adds, reorders and removes, then saves with the expected version', async () => {
    const user = userEvent.setup();
    renderScreen(<ElementGroupsAdmin />);
    const route = await generalCard();
    expect(route.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(route.getByLabelText(/Add a group/), 'أعمال خاصة');
    await user.click(route.getByRole('button', { name: 'Add' }));
    await user.click(route.getByRole('button', { name: 'Move بنادل up' }));
    await user.click(route.getByRole('button', { name: 'Remove حفر' }));
    await user.click(route.getByRole('button', { name: 'Save' }));
    expect(api.replaceElementGroups).toHaveBeenCalledWith('route_general', {
      mains: ['بنادل', 'أعمال خاصة'],
      expectedVersion: 3,
    });
  });

  it('does not add a name that is already there', async () => {
    const user = userEvent.setup();
    renderScreen(<ElementGroupsAdmin />);
    const route = await generalCard();
    await user.type(route.getByLabelText(/Add a group/), 'حفر');
    await user.click(route.getByRole('button', { name: 'Add' }));
    expect(route.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('asks for a reload on a version conflict (409) and reloads', async () => {
    const user = userEvent.setup();
    api.replaceElementGroups.mockRejectedValue(new ApiClientError('CONFLICT', 409));
    renderScreen(<ElementGroupsAdmin />);
    const route = await generalCard();
    await user.click(route.getByRole('button', { name: 'Remove حفر' }));
    await user.click(route.getByRole('button', { name: 'Save' }));
    expect(await route.findByRole('alert')).toHaveTextContent(
      'The list was changed by another user. Reload the page and try again.',
    );
    await user.click(route.getByRole('button', { name: 'Reload' }));
    expect(api.getElementGroups).toHaveBeenCalledTimes(2);
    expect(await generalCard()).toBeTruthy();
  });
});
