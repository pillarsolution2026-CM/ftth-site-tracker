import { z } from 'zod';
import { PROJECT_WIDE_ROLES, RoleSchema, type Role } from '../auth/roles.js';
import { ProjectEpsgSchema } from '../cad/crs-detection.schemas.js';

/**
 * Platform-admin setup (owner request 2026-10-30, ADR-026): projects, zones (name only), users and
 * assignments. Every route under `/admin` is platform-admin only, enforced by the API.
 */

export const LocaleSchema = z.enum(['ar', 'en', 'fr']);
export type Locale = z.infer<typeof LocaleSchema>;

const NameSchema = z.string().trim().min(1).max(200);

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  client: z.string(),
  /** Project CRS (metric). All project geometry is stored in it. */
  crsEpsg: z.number().int(),
  /** ISO 4217 code: the contract's currency; the work order copies it. */
  currency: z.string().length(3),
  locale: LocaleSchema,
  /**
   * Contract this project (= one work order) belongs to (ADR-027). Null only for projects created
   * before Phase 2.
   */
  contractId: z.uuid().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectListResponseSchema = z.object({ items: z.array(ProjectSchema) });
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

/**
 * POST /admin/projects. A project is one work order (أمر التكليف / المشروع) under a contract
 * (ADR-027): the client and the currency are taken from the contract. The CRS is the drawing's
 * CRS, limited to WGS 84 / UTM like the mapping screen.
 */
export const CreateProjectRequestSchema = z.strictObject({
  name: NameSchema,
  crsEpsg: ProjectEpsgSchema,
  contractId: z.uuid(),
  locale: LocaleSchema,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * PATCH /admin/projects/:projectId. The CRS, the contract, the client and the currency are fixed
 * at creation: geometry is stored in the CRS, and the client and currency come from the contract
 * (ADR-026, ADR-027).
 */
export const UpdateProjectRequestSchema = z
  .strictObject({
    name: NameSchema.optional(),
    locale: LocaleSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Zones (name only; boundaries arrive with the Phase 2 zones screen)
// ---------------------------------------------------------------------------------------------

export const ZoneSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** False until a boundary is drawn (Phase 2). */
  hasBoundary: z.boolean(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const ZoneListResponseSchema = z.object({ items: z.array(ZoneSchema) });
export type ZoneListResponse = z.infer<typeof ZoneListResponseSchema>;

export const CreateZoneRequestSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
export type CreateZoneRequest = z.infer<typeof CreateZoneRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/** Same limits as the `create-admin` CLI. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const AdminUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  locale: LocaleSchema,
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const UserListResponseSchema = z.object({ items: z.array(AdminUserSchema) });
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

/** POST /admin/users. Strict: an `isAdmin` field is rejected, so no route can create an admin. */
export const CreateUserRequestSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  locale: LocaleSchema.default('ar'),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type CreateUserInput = z.input<typeof CreateUserRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------------------------

/** Roles an admin may assign. `admin` is excluded: platform admins are created by the CLI only. */
export const ASSIGNABLE_ROLES = ['pm', 'supervisor', 'qc', 'contractor'] as const satisfies Role[];
export const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES);
export type AssignableRole = z.infer<typeof AssignableRoleSchema>;

/** Supervisor and contractor reach only their zones; without a zone they get nothing (fail closed). */
export function isZoneScopedRole(role: Role): boolean {
  return !PROJECT_WIDE_ROLES.includes(role);
}

/** POST /admin/projects/:projectId/assignments. Zone required for zone-scoped roles, forbidden otherwise. */
export const CreateAssignmentRequestSchema = z
  .strictObject({
    userId: z.uuid(),
    role: AssignableRoleSchema,
    zoneId: z.uuid().nullable().default(null),
  })
  .superRefine((body, ctx) => {
    const scoped = isZoneScopedRole(body.role);
    if (scoped && body.zoneId === null) {
      ctx.addIssue({ code: 'custom', path: ['zoneId'], message: 'This role needs a zone' });
    }
    if (!scoped && body.zoneId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['zoneId'],
        message: 'This role covers the whole project',
      });
    }
  });
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequestSchema>;
export type CreateAssignmentInput = z.input<typeof CreateAssignmentRequestSchema>;

export const AssignmentSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userEmail: z.string(),
  userDisplayName: z.string(),
  userIsActive: z.boolean(),
  role: RoleSchema,
  zoneId: z.uuid().nullable(),
  zoneName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const AssignmentListResponseSchema = z.object({ items: z.array(AssignmentSchema) });
export type AssignmentListResponse = z.infer<typeof AssignmentListResponseSchema>;

/** `events.entity` / `events.type` written by the admin routes (kept here to stay out of Phase 3 files). */
export const ADMIN_EVENT_TYPES = {
  projectCreated: 'project.created',
  /** Payload: `{ before, after }` of the changed fields. */
  projectUpdated: 'project.updated',
  zoneCreated: 'zone.created',
  /** Payload never contains the password or its hash. */
  userCreated: 'user.created',
  userDeactivated: 'user.deactivated',
  userReactivated: 'user.reactivated',
  assignmentCreated: 'assignment.created',
  /** Payload is the removed row (the row is hard-deleted). */
  assignmentRemoved: 'assignment.removed',
} as const;
