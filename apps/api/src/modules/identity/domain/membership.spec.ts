import { describe, expect, it } from 'vitest';
import { PROJECT_WIDE_ROLES } from '@ftth/shared';
import { grantsAccess, scopeForPermission, type ProjectAccess } from './membership.js';

const access = (grants: ProjectAccess['grants']): ProjectAccess => ({
  projectId: 'p',
  roles: [...new Set(grants.map((g) => g.role))],
  scope: { kind: 'project' },
  grants,
});

describe('scopeForPermission', () => {
  it('limits a qc + supervisor user to the supervisor sites for writes, project-wide for reads', () => {
    const mixed = access([
      { role: 'qc', siteIds: [] },
      { role: 'supervisor', siteIds: ['site-b'] },
    ]);
    expect(scopeForPermission(mixed, 'execution:write', false)).toEqual({
      kind: 'sites',
      siteIds: ['site-b'],
    });
    expect(scopeForPermission(mixed, 'execution:read', false)).toEqual({ kind: 'project' });
  });

  it('ignores sites of roles that do not grant the permission', () => {
    const mixed = access([
      { role: 'contractor', siteIds: ['site-a'] },
      { role: 'supervisor', siteIds: ['site-b'] },
    ]);
    expect(scopeForPermission(mixed, 'execution:write', false)).toEqual({
      kind: 'sites',
      siteIds: ['site-b'],
    });
    expect(
      scopeForPermission(
        access([{ role: 'contractor', siteIds: ['s'] }]),
        'execution:write',
        false,
      ),
    ).toBeNull();
  });

  it('gives a supervisor with no sites an empty site scope, not null', () => {
    expect(
      scopeForPermission(access([{ role: 'supervisor', siteIds: [] }]), 'execution:write', false),
    ).toEqual({ kind: 'sites', siteIds: [] });
  });

  it('opens the project to pm and platform admins', () => {
    expect(
      scopeForPermission(access([{ role: 'pm', siteIds: [] }]), 'execution:write', false),
    ).toEqual({ kind: 'project' });
    expect(scopeForPermission(access([]), 'execution:write', true)).toEqual({ kind: 'project' });
  });
});

describe('grantsAccess', () => {
  const row = (role: 'pm' | 'qc' | 'supervisor' | 'contractor') => ({
    projectId: 'p',
    projectName: 'P',
    role,
    siteIds: [],
  });

  it('grants project-wide roles and supervisors (even without sites), never a project contractor', () => {
    expect(grantsAccess(row('pm'), PROJECT_WIDE_ROLES)).toBe(true);
    expect(grantsAccess(row('qc'), PROJECT_WIDE_ROLES)).toBe(true);
    expect(grantsAccess(row('supervisor'), PROJECT_WIDE_ROLES)).toBe(true);
    expect(grantsAccess(row('contractor'), PROJECT_WIDE_ROLES)).toBe(false);
  });
});
