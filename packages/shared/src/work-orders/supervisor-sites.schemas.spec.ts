import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  OfflineBundleSchema,
  ProjectMembershipSchema,
  ReplaceSupervisorSitesRequestSchema,
} from '../index.js';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('supervisor sites (ADR-054)', () => {
  it('admin and pm give sites; qc, supervisor and contractor do not', () => {
    expect(hasPermission(['pm'], 'supervisor_sites:manage')).toBe(true);
    expect(hasPermission(['admin'], 'supervisor_sites:manage')).toBe(true);
    for (const role of ['qc', 'supervisor', 'contractor'] as const) {
      expect(hasPermission([role], 'supervisor_sites:manage')).toBe(false);
    }
  });

  it('replaces the sites in one go and refuses a repeated site', () => {
    expect(ReplaceSupervisorSitesRequestSchema.safeParse({ siteIds: [] }).success).toBe(true);
    expect(
      ReplaceSupervisorSitesRequestSchema.safeParse({ siteIds: [uuid(1), uuid(2)] }).success,
    ).toBe(true);
    expect(
      ReplaceSupervisorSitesRequestSchema.safeParse({ siteIds: [uuid(1), uuid(1)] }).success,
    ).toBe(false);
  });

  it('defaults a membership to no sites', () => {
    const membership = ProjectMembershipSchema.parse({
      projectId: uuid(1),
      projectName: 'P',
      role: 'supervisor',
      zoneIds: [],
    });
    expect(membership.siteIds).toEqual([]);
  });

  it('the bundle scope is the whole project or a list of sites, never zones', () => {
    const scope = OfflineBundleSchema.shape.scope;
    expect(scope.safeParse({ kind: 'sites', siteIds: [uuid(1)] }).success).toBe(true);
    expect(scope.safeParse({ kind: 'project' }).success).toBe(true);
    expect(scope.safeParse({ kind: 'zones', zoneIds: [uuid(1)] }).success).toBe(false);
  });
});
