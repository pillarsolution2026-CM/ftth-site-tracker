import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { DEFAULT_REVIEW_FILTER } from '../model/review-list';
import { link } from '../model/review-fixtures';
import { TextReviewView, type TextReviewState } from './text-review';

function state(overrides: Partial<TextReviewState> = {}): TextReviewState {
  return {
    filter: DEFAULT_REVIEW_FILTER,
    setFilter: vi.fn(),
    page: 1,
    setPage: vi.fn(),
    links: [],
    total: 0,
    pageSize: 50,
    loadErrorCode: null,
    pendingLinkId: null,
    errorKey: null,
    confirm: vi.fn(),
    reject: vi.fn(),
    reassign: {
      link: null,
      featureType: null,
      allowedTypes: [],
      searchDraft: '',
      setSearchDraft: vi.fn(),
      applySearch: vi.fn(),
      setFeatureType: vi.fn(),
      results: null,
      loading: false,
      errorCode: null,
      open: vi.fn(),
      close: vi.fn(),
      pick: vi.fn(),
    },
    ...overrides,
  };
}

describe('TextReviewView', () => {
  it('lists text, kind, layer, proposed feature, distance and confidence; default filter is review', () => {
    renderScreen(
      <TextReviewView
        canReview
        state={state({
          links: [link({ featureType: 'box', featureCode: '1-1', kind: 'box_id', text: '1-1' })],
          total: 1,
        })}
      />,
    );
    expect(screen.getByLabelText('Status')).toHaveValue('review');
    const row = screen.getByRole('row', { name: /1-1/ });
    expect(within(row).getByText('Box id')).toBeInTheDocument();
    expect(within(row).getByText('TXT')).toBeInTheDocument();
    expect(row).toHaveTextContent(/Box\s*1-1/);
    expect(within(row).getByText('2.5')).toBeInTheDocument();
    expect(within(row).getByText('0.612')).toBeInTheDocument();
  });

  it('marks unreadable texts and shows their raw text instead of guessing', () => {
    renderScreen(
      <TextReviewView
        canReview
        state={state({
          links: [
            link({
              readable: false,
              text: null,
              rawText: '%%U\\M+ABCD',
              kind: 'unreadable',
              featureId: null,
              featureType: null,
            }),
          ],
          total: 1,
        })}
      />,
    );
    expect(screen.getByText('Unreadable', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('%%U\\M+ABCD')).toBeInTheDocument();
    expect(screen.getByText('No candidate')).toBeInTheDocument();
    // nothing to confirm without a candidate; reject and reassign remain
    expect(screen.queryByRole('button', { name: /^Confirm/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reject/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reassign/ })).toBeInTheDocument();
  });

  it('calls confirm, reject and reassign for the row', async () => {
    const user = userEvent.setup();
    const current = link();
    const s = state({ links: [current], total: 1 });
    renderScreen(<TextReviewView canReview state={s} />);
    await user.click(screen.getByRole('button', { name: 'Confirm: F 36 C' }));
    await user.click(screen.getByRole('button', { name: 'Reject: F 36 C' }));
    await user.click(screen.getByRole('button', { name: 'Reassign: F 36 C' }));
    expect(s.confirm).toHaveBeenCalledWith(current);
    expect(s.reject).toHaveBeenCalledWith(current);
    expect(s.reassign.open).toHaveBeenCalledWith(current);
  });

  it('hides every action without design:write', () => {
    renderScreen(<TextReviewView canReview={false} state={state({ links: [link()], total: 1 })} />);
    expect(
      screen.queryByRole('button', { name: /Confirm|Reject|Reassign/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('reassigns to a feature picked from the search results', async () => {
    const user = userEvent.setup();
    const current = link({ kind: 'box_id', text: '1-1' });
    const s = state({
      links: [current],
      total: 1,
      reassign: {
        ...state().reassign,
        link: current,
        featureType: 'box',
        allowedTypes: ['box'],
        results: [
          {
            id: '6f8fad5b-d9cb-469f-a165-70867728950e',
            revisionId: current.revisionId,
            featureType: 'box',
            code: '1-2',
            layer: 'sub',
            blockName: 'sub',
            sourceKind: 'insert',
            sourceHandle: 'AB1',
            lengthM: null,
            anchor: { x: 1, y: 1 },
            attrs: {},
          },
        ],
      },
    });
    renderScreen(<TextReviewView canReview state={s} />);
    const panel = screen.getByRole('region', { name: /Reassign the link/ });
    expect(within(panel).getByLabelText('Feature type')).toHaveValue('box');
    await user.click(within(panel).getByRole('button', { name: 'Use this feature' }));
    expect(s.reassign.pick).toHaveBeenCalledWith('6f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('shows an error message for a refused review', () => {
    renderScreen(
      <TextReviewView
        canReview
        state={state({ links: [link()], total: 1, errorKey: 'design.error.REVISION_LOCKED' })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('no longer a draft');
  });

  it('says so when the filter matches nothing', () => {
    renderScreen(<TextReviewView canReview state={state()} />);
    expect(screen.getByText('No texts match this filter')).toBeInTheDocument();
  });
});
