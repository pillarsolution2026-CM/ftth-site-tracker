import {
  AdminUserSchema,
  AssignmentListResponseSchema,
  AssignmentSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UserListResponseSchema,
  ZoneListResponseSchema,
  ZoneSchema,
  type AdminUser,
  type Assignment,
  type AssignmentListResponse,
  type CreateAssignmentInput,
  type CreateProjectRequest,
  type CreateUserInput,
  type CreateZoneRequest,
  type Project,
  type ProjectListResponse,
  type UpdateProjectRequest,
  type UserListResponse,
  type Zone,
  type ZoneListResponse,
} from '@ftth/shared';
import { bffJson, bffVoid } from '@/shared/api/bff-client';

/** Platform-admin endpoints through the BFF (`/api/admin/...` → API `/admin/...`). */
const ADMIN = '/api/admin';
const project = (projectId: string) => `${ADMIN}/projects/${encodeURIComponent(projectId)}`;

export function listProjects(): Promise<ProjectListResponse> {
  return bffJson(`${ADMIN}/projects`, ProjectListResponseSchema);
}

export function createProject(body: CreateProjectRequest): Promise<Project> {
  return bffJson(`${ADMIN}/projects`, ProjectSchema, { method: 'POST', body });
}

export function updateProject(projectId: string, body: UpdateProjectRequest): Promise<Project> {
  return bffJson(project(projectId), ProjectSchema, { method: 'PATCH', body });
}

export function listZones(projectId: string): Promise<ZoneListResponse> {
  return bffJson(`${project(projectId)}/zones`, ZoneListResponseSchema);
}

export function createZone(projectId: string, body: CreateZoneRequest): Promise<Zone> {
  return bffJson(`${project(projectId)}/zones`, ZoneSchema, { method: 'POST', body });
}

export function listAssignments(projectId: string): Promise<AssignmentListResponse> {
  return bffJson(`${project(projectId)}/assignments`, AssignmentListResponseSchema);
}

export function createAssignment(
  projectId: string,
  body: CreateAssignmentInput,
): Promise<Assignment> {
  return bffJson(`${project(projectId)}/assignments`, AssignmentSchema, { method: 'POST', body });
}

export function removeAssignment(projectId: string, assignmentId: string): Promise<void> {
  return bffVoid(`${project(projectId)}/assignments/${encodeURIComponent(assignmentId)}`, {
    method: 'DELETE',
  });
}

export function listUsers(): Promise<UserListResponse> {
  return bffJson(`${ADMIN}/users`, UserListResponseSchema);
}

export function createUser(body: CreateUserInput): Promise<AdminUser> {
  return bffJson(`${ADMIN}/users`, AdminUserSchema, { method: 'POST', body });
}

export function setUserActive(userId: string, active: boolean): Promise<AdminUser> {
  const action = active ? 'reactivate' : 'deactivate';
  return bffJson(`${ADMIN}/users/${encodeURIComponent(userId)}/${action}`, AdminUserSchema, {
    method: 'POST',
  });
}
