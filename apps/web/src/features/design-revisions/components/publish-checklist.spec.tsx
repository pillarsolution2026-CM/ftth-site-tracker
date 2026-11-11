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
    other_drawing: 0,
    cabinets_match: 0,
    ...counts,
  };
  const keys = [
    'crs_known',
    'control_point',
    'no_problems',
    'open_items',
    'other_drawing',
    'cabinets_match',
  ] as const;
  return {
    checks: keys.map((key) => ({ key, ok: !failing.includes(key), count: base[key] })),
    canPublish: !failing.some((key) => key !== 'open_items'),
    drawingKind: 'general',
    otherRevisionId: null,
    needsAcknowledgement: failing.includes('open_items'),
    cabinets: null,
    warningCount: 0,
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
      otherRevisionHref={null}
      onAcknowledgedChange={onAcknowledgedChange}
      onPublish={onPublish}
      {...props}
    />,
  );
  return { onPublish, onAcknowledgedChange };
}

describe('PublishChecklist', () => {
  it('lists the six checks with an icon and a word each, with counts', () => {
    setup(readiness(['no_problems'], { no_problems: 5 }));
    expect(screen.getByText('Coordinates: source CRS chosen')).toBeInTheDocument();
    expect(screen.getByText(/At least one control point in use \(.*2.*\)/)).toBeInTheDocument();
    expect(screen.getByText(/No drawing errors \(.*5.* left\)/)).toBeInTheDocument();
    expect(screen.getByText(/Open items reviewed/)).toBeInTheDocument();
    expect(screen.getByText(/The other drawing \(Secondary\) is ready/)).toBeInTheDocument();
    expect(screen.getAllByText('✅')).toHaveLength(5);
    expect(screen.getByText('❌')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByText('(Done)')).toHaveLength(5);
    expect(screen.getByText('(Not done)')).toBeInTheDocument();
  });

  it.each([
    'crs_known',
    'control_point',
    'no_problems',
    'other_drawing',
    'cabinets_match',
  ] as const)('locks Publish when %s fails', (key) => {
    setup(readiness([key]));
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByText(/locked until all checks except open items/)).toBeInTheDocument();
  });

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

describe('PublishChecklist other drawing row (ADR-040)', () => {
  it('says there is no draft yet when the other drawing has none', () => {
    setup(readiness(['other_drawing'], { other_drawing: null }));
    expect(screen.getByText('There is no draft for the Secondary yet')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Open the Secondary draft/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the errors left in the other drawing and links to its draft', () => {
    setup(readiness(['other_drawing'], { other_drawing: 4 }), {
      otherRevisionHref: '/en/projects/p/design-revisions/o',
    });
    expect(screen.getByText(/4.* errors in it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Secondary draft' })).toHaveAttribute(
      'href',
      '/en/projects/p/design-revisions/o',
    );
  });

  it('names the General when this is the Secondary draft', () => {
    const data = {
      ...readiness(['other_drawing'], { other_drawing: null }),
      drawingKind: 'secondary' as const,
    };
    setup(data);
    expect(screen.getByText(/The other drawing \(General \(main\)\) is ready/)).toBeInTheDocument();
  });

  it('says both drawings are published together', () => {
    setup(readiness());
    expect(
      screen.getByText(/both drawings together \(General \(main\) \+ Secondary\)/),
    ).toBeInTheDocument();
  });
});

describe('PublishChecklist cabinets row (ADR-041)', () => {
  it('has the sixth row, done when the cabinets match', () => {
    setup(readiness());
    expect(
      screen.getByText('Cabinets match in both drawings (name and count)'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('✅')),
    ).toHaveLength(6);
    expect(screen.queryByText(/Only in the General/)).not.toBeInTheDocument();
  });

  it('lists the names that exist in one drawing only, and the counts', () => {
    const data: PublishReadiness = {
      ...readiness(['cabinets_match'], { cabinets_match: 3 }),
      cabinets: {
        ok: false,
        general: { count: 9, unnamed: 0, missingInOther: ['1-9', '2-1'] },
        secondary: { count: 8, unnamed: 1, missingInOther: ['1-8'] },
      },
    };
    setup(data);
    expect(screen.getByText('❌')).toBeInTheDocument();
    expect(screen.getByText(/Cabinets: General .*9.* \/ Secondary .*8/)).toBeInTheDocument();
    const general = screen.getByText(/Only in the General/);
    expect(general).toHaveTextContent('1-9');
    expect(general).toHaveTextContent('2-1');
    expect(screen.getByText(/Only in the Secondary/)).toHaveTextContent('1-8');
    expect(screen.getByText(/Cabinets with no name: .*1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('says there is nothing to compare with while the other draft is missing', () => {
    setup(
      readiness(['cabinets_match', 'other_drawing'], { cabinets_match: null, other_drawing: null }),
    );
    expect(
      screen.getByText('There is no draft for the Secondary to compare with'),
    ).toBeInTheDocument();
  });

  it('shows the warning count without blocking', () => {
    setup({ ...readiness(), warningCount: 3 });
    expect(screen.getByText(/3.* warning\(s\) in this drawing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
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
