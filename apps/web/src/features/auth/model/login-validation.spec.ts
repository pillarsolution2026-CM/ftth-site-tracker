import { describe, expect, it } from 'vitest';
import { validateLogin } from './login-validation';

describe('validateLogin', () => {
  it('flags invalid email and short password', () => {
    expect(validateLogin({ email: 'nope', password: '123' })).toEqual({
      ok: false,
      errors: { email: 'auth.emailInvalid', password: 'auth.passwordTooShort' },
    });
  });

  it('trims the email and accepts valid input', () => {
    expect(validateLogin({ email: ' pm@example.com ', password: 'long-enough' })).toEqual({
      ok: true,
      data: { email: 'pm@example.com', password: 'long-enough' },
    });
  });
});
