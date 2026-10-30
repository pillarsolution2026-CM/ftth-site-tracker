import { describe, expect, it } from 'vitest';
import { redactedDbError } from './pg-errors.js';

describe('redactedDbError', () => {
  it('keeps the pg code and constraint but drops the query and its params', () => {
    const driverError = Object.assign(new Error('timeout'), { code: '57014' });
    const wrapped = Object.assign(
      new Error('Failed query: insert into "users" ... params: a@b.co,$argon2id$v=19$secret'),
      { cause: driverError },
    );
    const redacted = redactedDbError(wrapped, 'user insert');
    expect(redacted.message).toBe('user insert failed (pg 57014)');
    expect(redacted.message).not.toContain('argon2');
    expect(redacted).not.toHaveProperty('cause');
  });

  it('works when the cause is not a pg error', () => {
    expect(redactedDbError(new Error('x params: secret'), 'op').message).toBe(
      'op failed (unknown cause)',
    );
  });
});
