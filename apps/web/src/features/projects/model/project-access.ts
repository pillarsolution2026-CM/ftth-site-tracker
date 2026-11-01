import { hasPermission, type MeResponse, type Permission, type Role } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';

export type ProjectAccess =
  | {
      status: 'member';
      projectId: string;
      projectName: string | null;
      roles: Role[];
      isAdmin: boolean;
    }
  | { status: 'not_member' };

/** Roles of the signed-in user in one project. Platform admins pass even without a membership. */
export function resolveProjectAccess(me: MeResponse, projectId: string): ProjectAccess {
  const memberships = me.memberships.filter((membership) => membership.projectId === projectId);
  if (memberships.length === 0 && !me.isAdmin) return { status: 'not_member' };
  return {
    status: 'member',
    projectId,
    projectName: memberships[0]?.projectName ?? null,
    roles: memberships.map((membership) => membership.role),
    isAdmin: me.isAdmin,
  };
}

/** UI hint only; the API stays the authority. */
export function can(access: ProjectAccess, permission: Permission): boolean {
  if (access.status !== 'member') return false;
  return access.isAdmin || hasPermission(access.roles, permission);
}

export interface NavItem {
  id: 'workOrders' | 'cadFiles' | 'designRevisions' | 'contract' | 'asbuilt';
  labelKey: MessageKey;
  /** Path below `/{locale}/projects/{projectId}`. */
  segment: string;
  permission: Permission;
}

/** Later phases append their screens here. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'workOrders',
    labelKey: 'nav.workOrders',
    segment: 'work-orders',
    permission: 'work_orders:read',
  },
  { id: 'cadFiles', labelKey: 'nav.cadFiles', segment: 'cad-files', permission: 'cad_files:read' },
  {
    id: 'designRevisions',
    labelKey: 'nav.designRevisions',
    segment: 'design-revisions',
    permission: 'design:read',
  },
  // The PM (and the platform admin) read the contract and BOQ of the project (ADR-027).
  { id: 'contract', labelKey: 'nav.contract', segment: 'contract', permission: 'contract:read' },
  // Phase 4: review of the As-Built edits recorded on the phones (and the DXF export).
  {
    id: 'asbuilt',
    labelKey: 'asbuiltReview.nav',
    segment: 'asbuilt',
    permission: 'asbuilt:read',
  },
];

export function visibleNavItems(access: ProjectAccess): NavItem[] {
  return NAV_ITEMS.filter((item) => can(access, item.permission));
}

export function projectBasePath(locale: string, projectId: string): string {
  return `/${locale}/projects/${projectId}`;
}

/** Where a project link should land: the first section the user may read. */
export function firstSectionPath(locale: string, access: ProjectAccess): string | null {
  const first = visibleNavItems(access)[0];
  return first && access.status === 'member'
    ? `${projectBasePath(locale, access.projectId)}/${first.segment}`
    : null;
}
