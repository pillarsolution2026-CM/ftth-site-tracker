import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstallationState } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { InstallationQuestionCard } from './installation-question-card';

const api = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  setInstallationAnswer: vi.fn(),
  createTrenchMark: vi.fn(),
  withdrawTrenchMark: vi.fn(),
}));
vi.mock('../api/installation-api', () => api);

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FILE = '33333333-3333-4333-8333-333333333333';
const ANSWER_ID = '44444444-4444-4444-8444-444444444444';
const MARK = '55555555-5555-4555-8555-555555555551';

function live(overrides: Partial<InstallationState> = {}): InstallationState {
  return {
    cadFileId: FILE,
    drawingKind: 'general',
    asked: true,
    answer: null,
    answerHistory: [],
    marks: [],
    activeMarkCount: 0,
    activeTrenchM: '0.000',
    ...overrides,
  };
}

const answered = (answer: 'pull_only' | 'has_trench') => ({
  id: ANSWER_ID,
  cadFileId: FILE,
  answer,
  answeredBy: null,
  answeredAt: '2026-11-12T10:00:00.000Z',
});

function renderCard(props: Partial<Parameters<typeof InstallationQuestionCard>[0]> = {}) {
  renderScreen(
    <InstallationQuestionCard projectId={PROJECT} cadFileId={FILE} enabled canWrite {...props} />,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getInstallation.mockResolvedValue(live());
});

describe('InstallationQuestionCard (ADR-042)', () => {
  it('asks the owner question with the two answers while unanswered', async () => {
    renderCard();
    expect(
      await screen.findByText(
        'Is the whole route pulled through old pipes, or does part of it need digging and new pipes?',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All pulled through old pipes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Part needs digging and new pipes' })).toBeEnabled();
    expect(screen.getByText(/publishing stays locked/)).toBeInTheDocument();
  });

  it('says the question in Arabic with the exact wording', async () => {
    renderScreen(
      <InstallationQuestionCard projectId={PROJECT} cadFileId={FILE} enabled canWrite />,
      { locale: 'ar' },
    );
    expect(
      await screen.findByText(
        'المسار كله سحب في مواسير قديمة، ولا فيه جزء محتاج حفر وتركيب مواسير؟',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'كله سحب في مواسير قديمة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'فيه جزء حفر وتركيب مواسير' })).toBeInTheDocument();
  });

  it('saves the chosen answer', async () => {
    api.setInstallationAnswer.mockResolvedValue(answered('has_trench'));
    renderCard();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Part needs digging and new pipes' }),
    );
    await waitFor(() =>
      expect(api.setInstallationAnswer).toHaveBeenCalledWith(PROJECT, FILE, {
        answer: 'has_trench',
      }),
    );
  });

  it('marks the current answer with a check and aria-pressed, not by colour alone', async () => {
    api.getInstallation.mockResolvedValue(live({ answer: answered('pull_only') }));
    renderCard();
    const current = await screen.findByRole('button', { name: /All pulled through old pipes/ });
    expect(current).toHaveAttribute('aria-pressed', 'true');
    expect(current).toHaveTextContent('✓');
    expect(screen.getByText('Current answer: All pulled through old pipes')).toBeInTheDocument();
    expect(screen.queryByText(/publishing stays locked/)).not.toBeInTheDocument();
  });

  it('shows the refusal when marks are still in force', async () => {
    api.getInstallation.mockResolvedValue(live({ answer: answered('has_trench') }));
    api.setInstallationAnswer.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'TRENCH_MARKS_ACTIVE' }),
    );
    renderCard();
    await userEvent.click(
      await screen.findByRole('button', { name: 'All pulled through old pipes' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Withdraw them all/);
  });

  it('renders nothing for a Secondary', async () => {
    api.getInstallation.mockResolvedValue(live({ asked: false, drawingKind: 'secondary' }));
    renderCard();
    await waitFor(() => expect(api.getInstallation).toHaveBeenCalled());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not ask the server at all while disabled', () => {
    renderCard({ enabled: false });
    expect(api.getInstallation).not.toHaveBeenCalled();
  });

  it('is read-only without write permission', async () => {
    renderCard({ canWrite: false });
    expect(
      await screen.findByRole('button', { name: 'All pulled through old pipes' }),
    ).toBeDisabled();
    expect(screen.getByText(/project manager changes it/)).toBeInTheDocument();
  });

  it('tells to rebuild when the answer or marks changed since the draft', async () => {
    api.getInstallation.mockResolvedValue(live({ answer: answered('pull_only') }));
    renderCard({ frozen: { answer: null, answerId: null, marks: [] } });
    expect(await screen.findByText('Rebuild so the marks are applied')).toBeInTheDocument();
  });

  it('does not tell to rebuild when the draft froze the live state', async () => {
    api.getInstallation.mockResolvedValue(
      live({
        answer: answered('has_trench'),
        marks: [
          {
            id: MARK,
            cadFileId: FILE,
            routeHandle: 'A1',
            lengthM: '5.000',
            createdBy: null,
            createdAt: '2026-11-12T10:00:00.000Z',
            withdrawnBy: null,
            withdrawnAt: null,
          },
        ],
        activeMarkCount: 1,
      }),
    );
    renderCard({
      frozen: {
        answer: 'has_trench',
        answerId: ANSWER_ID,
        marks: [{ id: MARK, routeHandle: 'A1', lengthM: '5.000' }],
      },
    });
    await screen.findByText(/Mark the trench parts in the drawing viewer/);
    expect(screen.queryByText('Rebuild so the marks are applied')).not.toBeInTheDocument();
  });
});
