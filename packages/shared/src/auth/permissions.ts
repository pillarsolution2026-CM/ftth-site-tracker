import type { Role } from './roles.js';

/**
 * Permission strings checked by the API guard (`RequirePermission`) and used by web/mobile to hide actions.
 * ASSUMPTION (ADR-011, to be confirmed by the owner): see ROLE_PERMISSIONS.
 */
export const PERMISSIONS = [
  'work_orders:read',
  'work_orders:write',
  'cad_files:read',
  'cad_files:write',
  'design:read',
  'design:write',
  /** Read execution updates (Phase 3). */
  'execution:read',
  /** Record execution updates from the mobile app (Phase 3). ASSUMPTION: supervisor, pm, admin. */
  'execution:write',
  /** Read the contract and BOQ of the project (Phase 2, ADR-027): admin and pm only (owner). */
  'contract:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: readonly Permission[] = [
  'work_orders:read',
  'cad_files:read',
  'design:read',
  'execution:read',
];

/** Role → permissions inside a project. Platform admins (`isAdmin`) always pass. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  pm: PERMISSIONS,
  qc: READ,
  supervisor: [...READ, 'execution:write'],
  contractor: [],
};

/** True when any of the user's roles in the project grants the permission. */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
