import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/shared/i18n/locale-provider';
import { LoginForm } from './login-form';

const mutate = vi.fn();
let mutationState: { isPending: boolean; error: unknown } = { isPending: false, error: null };

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('../api/queries', () => ({
  useLoginMutation: () => ({ mutate, ...mutationState }),
}));

function renderForm(locale: 'ar' | 'en' = 'en') {
  return render(
    <LocaleProvider locale={locale}>
      <LoginForm />
    </LocaleProvider>,
  );
}

describe('LoginForm', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutationState = { isPending: false, error: null };
  });

  it('shows validation messages and does not submit invalid input', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), '123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('submits valid credentials through the login mutation', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Email'), 'pm@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mutate).toHaveBeenCalledWith(
      { email: 'pm@example.com', password: 'correct-password' },
      expect.any(Object),
    );
  });

  it('keeps email and password fields left-to-right', () => {
    renderForm('ar');
    expect(screen.getByLabelText('البريد الإلكتروني')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('كلمة المرور')).toHaveAttribute('dir', 'ltr');
  });
});
