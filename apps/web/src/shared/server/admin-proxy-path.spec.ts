import { describe, expect, it } from 'vitest';
import { adminUpstreamPath } from './admin-proxy-path';

describe('adminUpstreamPath', () => {
  it('maps admin resources under /admin', () => {
    expect(adminUpstreamPath(['projects'])).toBe('/admin/projects');
    expect(adminUpstreamPath(['contracts'])).toBe('/admin/contracts');
    expect(adminUpstreamPath(['contractors'])).toBe('/admin/contractors');
    expect(adminUpstreamPath(['contracts', 'abc', 'attachments', 'def'])).toBe(
      '/admin/contracts/abc/attachments/def',
    );
    expect(adminUpstreamPath(['users', 'abc', 'deactivate'])).toBe('/admin/users/abc/deactivate');
  });

  it('rejects other resources and path tricks', () => {
    expect(adminUpstreamPath([])).toBeNull();
    expect(adminUpstreamPath(['auth', 'login'])).toBeNull();
    expect(adminUpstreamPath(['projects', '..', '..', 'auth'])).toBeNull();
    expect(adminUpstreamPath(['users', 'a/b'])).toBeNull();
    expect(adminUpstreamPath(['users', '%2e%2e'])).toBeNull();
  });

  it('exposes only the two element-groups paths (ADR-056)', () => {
    expect(adminUpstreamPath(['element-groups'])).toBe('/admin/element-groups');
    expect(adminUpstreamPath(['element-groups', 'route_general'])).toBe(
      '/admin/element-groups/route_general',
    );
    expect(adminUpstreamPath(['element-groups', 'planning'])).toBe(
      '/admin/element-groups/planning',
    );
    expect(adminUpstreamPath(['element-groups', 'nope'])).toBeNull();
    expect(adminUpstreamPath(['element-groups', '..'])).toBeNull();
    expect(adminUpstreamPath(['element-groups', 'box', 'extra'])).toBeNull();
  });
});
