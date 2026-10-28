import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { PublishDialog } from './publish-dialog';
import { RevisionStatusBadge } from './revision-status-badge';

describe('PublishDialog', () => {
  it('shows the open-item counts and needs the acknowledgement before confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onAcknowledgedChange = vi.fn();
    const blocked = { reason: 'OPEN_ITEMS', textLinksToReview: 4, diffConflicts: 1 } as const;
    renderScreen(
      <PublishDialog
        blocked={blocked}
        acknowledged={false}
        publishing={false}
        onAcknowledgedChange={onAcknowledgedChange}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/4.*text links still need review and.*1.*changes are conflicts/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish anyway' })).toBeDisabled();

    await user.click(screen.getByLabelText(/I understand/));
    expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
  });

  it('confirms once acknowledged', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderScreen(
      <PublishDialog
        blocked={{ reason: 'OPEN_ITEMS', textLinksToReview: 1, diffConflicts: 0 }}
        acknowledged
        publishing={false}
        onAcknowledgedChange={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Publish anyway' }));
    expect(onConfirm).toHaveBeenCalled();
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
