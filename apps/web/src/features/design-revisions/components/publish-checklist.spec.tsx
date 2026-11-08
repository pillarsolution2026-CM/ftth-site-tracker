import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishCheckKey, PublishReadiness } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { PublishChecklist } from './publish-checklist';
import { RevisionStatusBadge } from './revision-status-badge';

function readiness(
  failing: PublishCheckKey[] = [],
  counts: Partial<Record<PublishCheckKey, number | null>> = {},
): PublishReadiness {
  const base: Record<PublishCheckKey, number | null> = {
    crs_known: null,
    control_point: 2,
    no_problems: 0,
    open_items: 0,
    ...counts,
  };
  const keys = ['crs_known', 'control_point', 'no_problems', 'open_items'] as const;
  return {
    checks: keys.map((key) => ({ key, ok: !failing.includes(key), count: base[key] })),
    canPublish: !failing.some((key) => key !== 'open_items'),
    needsAcknowledgement: failing.includes('open_items'),
  };
}

function setup(
  data: PublishReadiness | null,
  props: Partial<Parameters<typeof PublishChecklist>[0]> = {},
) {
  const onPublish = vi.fn();
  const onAcknowledgedChange = vi.fn();
  renderScreen(
    <PublishChecklist
      readiness={data}
      loading={false}
      failed={false}
      acknowledged={false}
      publishing={false}
      allowed={data?.canPublish === true && !data.needsAcknowledgement}
      mappingHref="/en/projects/p/cad-files/f/mapping"
      onAcknowledgedChange={onAcknowledgedChange}
      onPublish={onPublish}
      {...props}
    />,
  );
  return { onPublish, onAcknowledgedChange };
}

describe('PublishChecklist', () => {
  it('lists the four checks with an icon and a word each, with counts', () => {
    setup(readiness(['no_problems'], { no_problems: 5 }));
    expect(screen.getByText('Coordinates: source CRS chosen')).toBeInTheDocument();
    expect(screen.getByText(/At least one control point in use \(.*2.*\)/)).toBeInTheDocument();
    expect(screen.getByText(/No drawing errors \(.*5.* left\)/)).toBeInTheDocument();
    expect(screen.getByText(/Open items reviewed/)).toBeInTheDocument();
    expect(screen.getAllByText('✅')).toHaveLength(3);
    expect(screen.getByText('❌')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByText('(Done)')).toHaveLength(3);
    expect(screen.getByText('(Not done)')).toBeInTheDocument();
  });

  it.each(['crs_known', 'control_point', 'no_problems'] as const)(
    'locks Publish when %s fails',
    (key) => {
      setup(readiness([key]));
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
      expect(screen.getByText(/locked until the first three checks/)).toBeInTheDocument();
    },
  );

  it('enables Publish when every check is ok and publishes on click', async () => {
    const user = userEvent.setup();
    const { onPublish } = setup(readiness());
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onPublish).toHaveBeenCalled();
  });

  it('still needs the acknowledgement for open items', async () => {
    const user = userEvent.setup();
    const { onAcknowledgedChange } = setup(readiness(['open_items'], { open_items: 4 }));
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand/));
    expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
  });

  it('enables Publish once the open items are acknowledged', () => {
    setup(readiness(['open_items'], { open_items: 4 }), { acknowledged: true, allowed: true });
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('links failed coordinate checks to the mapping screen, but no other check', () => {
    setup(readiness(['crs_known', 'no_problems']));
    const links = screen.getAllByRole('link', { name: 'Open the coordinates screen' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/en/projects/p/cad-files/f/mapping');
  });

  it('keeps Publish disabled while readiness is loading', () => {
    setup(null, { loading: true, allowed: false });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
});

describe('RevisionStatusBadge', () => {
  it.each([
    ['queued', 'Queued', '…'],
    ['building', 'Building', '⟳'],
    ['draft', 'Draft', '✎'],
    ['failed', 'Failed', '✕'],
    ['published', 'Published', '✓'],
    ['discarded', 'Discarded', '⊘'],
  ] as const)('shows %s with an icon and text, not colour alone', (status, label, icon) => {
    renderScreen(<RevisionStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(icon)).toHaveAttribute('aria-hidden', 'true');
  });
});
