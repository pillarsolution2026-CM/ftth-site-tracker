import { describe, expect, it } from 'vitest';
import { LoginRequestSchema, RoleSchema } from '../index.js';

describe('auth contracts', () => {
  it('accepts a valid login request', () => {
    expect(LoginRequestSchema.parse({ email: 'pm@example.com', password: 'secret-pass' })).toEqual({
      email: 'pm@example.com',
      password: 'secret-pass',
    });
  });

  it('rejects a short password', () => {
    expect(LoginRequestSchema.safeParse({ email: 'pm@example.com', password: '123' }).success).toBe(
      false,
    );
  });

  it('only knows the five platform roles', () => {
    expect(RoleSchema.options).toEqual(['admin', 'pm', 'supervisor', 'qc', 'contractor']);
  });
});
