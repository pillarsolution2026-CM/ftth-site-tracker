import { describe, expect, it } from 'vitest';
import { adminUpstreamPath } from './admin-proxy-path';

describe('adminUpstreamPath', () => {
  it('maps admin resources under /admin', () => {
    expect(adminUpstreamPath(['projects'])).toBe('/admin/projects');
    expect(adminUpstreamPath(['users', 'abc', 'deactivate'])).toBe('/admin/users/abc/deactivate');
  });

  it('rejects other resources and path tricks', () => {
    expect(adminUpstreamPath([])).toBeNull();
    expect(adminUpstreamPath(['auth', 'login'])).toBeNull();
    expect(adminUpstreamPath(['projects', '..', '..', 'auth'])).toBeNull();
    expect(adminUpstreamPath(['users', 'a/b'])).toBeNull();
    expect(adminUpstreamPath(['users', '%2e%2e'])).toBeNull();
  });
});
