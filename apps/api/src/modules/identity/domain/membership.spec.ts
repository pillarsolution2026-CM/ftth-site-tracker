import { describe, expect, it } from 'vitest';
import { scopeForPermission, type ProjectAccess } from './membership.js';

const access = (grants: ProjectAccess['grants']): ProjectAccess => ({
  projectId: 'p',
  roles: [...new Set(grants.map((g) => g.role))],
  scope: { kind: 'project' },
  grants,
});

describe('scopeForPermission', () => {
  it('limits a qc + supervisor user to the supervisor zones for writes, project-wide for reads', () => {
    const mixed = access([
      { role: 'qc', zoneId: null },
      { role: 'supervisor', zoneId: 'zone-b' },
    ]);
    expect(scopeForPermission(mixed, 'execution:write', false)).toEqual({
      kind: 'zones',
      zoneIds: ['zone-b'],
    });
    expect(scopeForPermission(mixed, 'execution:read', false)).toEqual({ kind: 'project' });
  });

  it('ignores zones of roles that do not grant the permission', () => {
    const mixed = access([
      { role: 'contractor', zoneId: 'zone-a' },
      { role: 'supervisor', zoneId: 'zone-b' },
    ]);
    expect(scopeForPermission(mixed, 'execution:write', false)).toEqual({
      kind: 'zones',
      zoneIds: ['zone-b'],
    });
    expect(
      scopeForPermission(access([{ role: 'contractor', zoneId: 'z' }]), 'execution:write', false),
    ).toBeNull();
  });

  it('opens the project to pm and platform admins', () => {
    expect(
      scopeForPermission(access([{ role: 'pm', zoneId: null }]), 'execution:write', false),
    ).toEqual({ kind: 'project' });
    expect(scopeForPermission(access([]), 'execution:write', true)).toEqual({ kind: 'project' });
  });
});
