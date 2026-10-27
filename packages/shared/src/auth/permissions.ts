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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: readonly Permission[] = ['work_orders:read', 'cad_files:read'];

/** Role → permissions inside a project. Platform admins (`isAdmin`) always pass. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  pm: PERMISSIONS,
  qc: READ,
  supervisor: READ,
  contractor: [],
};

/** True when any of the user's roles in the project grants the permission. */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
