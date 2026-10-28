import type { MeResponse } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { can, firstSectionPath, resolveProjectAccess, visibleNavItems } from './project-access';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1f8fad5b-d9cb-469f-a165-70867728950e';

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 'b3b5c5a2-1f0e-4c5e-8a4b-6d2f9a7e1c10',
    email: 'u@example.com',
    displayName: 'U',
    locale: 'en',
    isAdmin: false,
    memberships: [],
    ...overrides,
  };
}

const membership = (projectId: string, role: MeResponse['memberships'][number]['role']) => ({
  projectId,
  projectName: `Project ${projectId.slice(0, 1)}`,
  role,
  zoneIds: [],
});

describe('project access and navigation', () => {
  it('shows every section to a project manager', () => {
    const access = resolveProjectAccess(me({ memberships: [membership(P1, 'pm')] }), P1);
    expect(visibleNavItems(access).map((item) => item.id)).toEqual([
      'workOrders',
      'cadFiles',
      'designRevisions',
    ]);
    expect(can(access, 'work_orders:write')).toBe(true);
  });

  it('gives a QC user read access but no write actions', () => {
    const access = resolveProjectAccess(me({ memberships: [membership(P1, 'qc')] }), P1);
    expect(visibleNavItems(access)).toHaveLength(3);
    expect(can(access, 'design:write')).toBe(false);
    expect(can(access, 'work_orders:write')).toBe(false);
    expect(can(access, 'cad_files:write')).toBe(false);
  });

  it('hides everything from a contractor', () => {
    const access = resolveProjectAccess(me({ memberships: [membership(P1, 'contractor')] }), P1);
    expect(visibleNavItems(access)).toEqual([]);
    expect(firstSectionPath('en', access)).toBeNull();
  });

  it('uses the role of the requested project only', () => {
    const user = me({ memberships: [membership(P1, 'pm'), membership(P2, 'contractor')] });
    expect(can(resolveProjectAccess(user, P2), 'work_orders:read')).toBe(false);
    expect(can(resolveProjectAccess(user, P1), 'work_orders:read')).toBe(true);
  });

  it('rejects non-members but lets platform admins in', () => {
    expect(resolveProjectAccess(me(), P1).status).toBe('not_member');
    const admin = resolveProjectAccess(me({ isAdmin: true }), P1);
    expect(can(admin, 'cad_files:write')).toBe(true);
  });

  it('links to the first readable section', () => {
    const access = resolveProjectAccess(me({ memberships: [membership(P1, 'supervisor')] }), P1);
    expect(firstSectionPath('ar', access)).toBe(`/ar/projects/${P1}/work-orders`);
  });
});
