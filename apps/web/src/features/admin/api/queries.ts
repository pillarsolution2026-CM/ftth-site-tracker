import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateAssignmentInput,
  CreateProjectRequest,
  CreateUserInput,
  CreateZoneRequest,
  UpdateProjectRequest,
} from '@ftth/shared';
import { meQueryKey } from '@/features/auth/api/queries';
import {
  createAssignment,
  createProject,
  createUser,
  createZone,
  listAssignments,
  listProjects,
  listUsers,
  listZones,
  removeAssignment,
  setUserActive,
  updateProject,
} from './admin-api';

export const adminProjectsKey = ['admin', 'projects'] as const;
export const adminUsersKey = ['admin', 'users'] as const;
export const adminZonesKey = (projectId: string) => ['admin', 'zones', projectId] as const;
export const adminAssignmentsKey = (projectId: string) =>
  ['admin', 'assignments', projectId] as const;

/** Every project; only call it for platform admins (`enabled`). */
export function useAdminProjects(enabled = true) {
  return useQuery({ enabled, queryKey: adminProjectsKey, queryFn: listProjects, retry: false });
}

export function useAdminUsers() {
  return useQuery({ queryKey: adminUsersKey, queryFn: listUsers, retry: false });
}

export function useAdminZones(projectId: string) {
  return useQuery({
    queryKey: adminZonesKey(projectId),
    queryFn: () => listZones(projectId),
    retry: false,
  });
}

export function useAdminAssignments(projectId: string) {
  return useQuery({
    queryKey: adminAssignmentsKey(projectId),
    queryFn: () => listAssignments(projectId),
    retry: false,
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => createProject(body),
    onSuccess: () => client.invalidateQueries({ queryKey: adminProjectsKey }),
  });
}

export function useUpdateProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) => updateProject(projectId, body),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: adminProjectsKey }),
        client.invalidateQueries({ queryKey: meQueryKey }),
      ]),
  });
}

export function useCreateZone(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateZoneRequest) => createZone(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: adminZonesKey(projectId) }),
  });
}

export function useCreateAssignment(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAssignmentInput) => createAssignment(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: adminAssignmentsKey(projectId) }),
  });
}

export function useRemoveAssignment(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => removeAssignment(projectId, assignmentId),
    onSuccess: () => client.invalidateQueries({ queryKey: adminAssignmentsKey(projectId) }),
  });
}

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserInput) => createUser(body),
    onSuccess: () => client.invalidateQueries({ queryKey: adminUsersKey }),
  });
}

export function useSetUserActive() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) =>
      setUserActive(userId, active),
    // Assignment lists show whether each user is active.
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin'] }),
  });
}
