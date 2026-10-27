import { z } from 'zod';

export const ROLES = ['admin', 'pm', 'supervisor', 'qc', 'contractor'] as const;

export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Roles that see every zone of a project they are assigned to. */
export const PROJECT_WIDE_ROLES: readonly Role[] = ['admin', 'pm', 'qc'];
