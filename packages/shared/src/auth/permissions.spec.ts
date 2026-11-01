import { describe, expect, it } from 'vitest';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';
import { ROLES } from './roles.js';

describe('permissions', () => {
  it('defines permissions for every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it('lets admin and pm do everything', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission(['admin'], permission)).toBe(true);
      expect(hasPermission(['pm'], permission)).toBe(true);
    }
  });

  it('gives qc and supervisor read-only access', () => {
    for (const role of ['qc', 'supervisor'] as const) {
      expect(hasPermission([role], 'work_orders:read')).toBe(true);
      expect(hasPermission([role], 'cad_files:read')).toBe(true);
      expect(hasPermission([role], 'work_orders:write')).toBe(false);
      expect(hasPermission([role], 'cad_files:write')).toBe(false);
    }
  });

  it('lets supervisors record execution updates but not qc (Phase 3 assumption)', () => {
    expect(hasPermission(['supervisor'], 'execution:write')).toBe(true);
    expect(hasPermission(['supervisor'], 'execution:read')).toBe(true);
    expect(hasPermission(['qc'], 'execution:read')).toBe(true);
    expect(hasPermission(['qc'], 'execution:write')).toBe(false);
  });

  it('As-Built (Phase 4 assumptions): supervisors record, qc reviews, only pm/admin export', () => {
    expect(hasPermission(['supervisor'], 'asbuilt:write')).toBe(true);
    expect(hasPermission(['supervisor'], 'asbuilt:read')).toBe(true);
    expect(hasPermission(['supervisor'], 'asbuilt:review')).toBe(false);
    expect(hasPermission(['supervisor'], 'asbuilt:export')).toBe(false);
    expect(hasPermission(['qc'], 'asbuilt:review')).toBe(true);
    expect(hasPermission(['qc'], 'asbuilt:write')).toBe(false);
    expect(hasPermission(['qc'], 'asbuilt:export')).toBe(false);
  });

  it('gives contractor nothing for now', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission(['contractor'], permission)).toBe(false);
    }
  });

  it('grants when any role grants', () => {
    expect(hasPermission(['contractor', 'pm'], 'work_orders:write')).toBe(true);
    expect(hasPermission([], 'work_orders:read')).toBe(false);
  });
});
