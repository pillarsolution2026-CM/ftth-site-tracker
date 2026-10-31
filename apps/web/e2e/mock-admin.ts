/**
 * Admin routes of the mock API (`/admin/...`). In-memory state; bodies are validated and answers
 * parsed with the shared schemas, so the mock follows the contract. Only platform-admin tokens
 * reach this handler (mock-api.ts answers 403 to others).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AdminUserSchema,
  AssignmentListResponseSchema,
  AssignmentSchema,
  CreateAssignmentRequestSchema,
  CreateProjectRequestSchema,
  CreateUserRequestSchema,
  CreateZoneRequestSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
  UserListResponseSchema,
  ZoneListResponseSchema,
  ZoneSchema,
} from '@ftth/shared';
import { contractTerms, countProject, handleContracts } from './mock-contracts.ts';
import type { Helpers } from './mock-design.ts';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_ACCESS = 'mock-admin-access-token';
export const ADMIN_REFRESH = 'mock-admin-refresh-token-0123456789abcdef0123';
const ADMIN_ID = '7d1f6a8e-3c4b-4f2a-9e1d-5b6c7a8d9e0f';
const NOW = '2026-10-30T08:00:00.000Z';

export const ADMIN_ME = {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  displayName: 'مدير النظام',
  locale: 'ar',
  isAdmin: true,
  memberships: [],
};

interface State {
  projects: {
    id: string;
    name: string;
    client: string;
    crsEpsg: number;
    currency: string;
    locale: 'ar' | 'en' | 'fr';
    contractId: string | null;
  }[];
  zones: { id: string; projectId: string; name: string }[];
  users: {
    id: string;
    email: string;
    displayName: string;
    locale: 'ar' | 'en' | 'fr';
    isAdmin: boolean;
    isActive: boolean;
    createdAt: string;
  }[];
  assignments: {
    id: string;
    projectId: string;
    userId: string;
    role: string;
    zoneId: string | null;
    createdAt: string;
  }[];
}

export function createAdminState(project: {
  id: string;
  name: string;
  contractId: string | null;
}): State {
  return {
    projects: [{ ...project, client: 'Client', crsEpsg: 32636, currency: 'EGP', locale: 'ar' }],
    zones: [],
    users: [
      {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        displayName: 'مدير النظام',
        locale: 'ar',
        isAdmin: true,
        isActive: true,
        createdAt: NOW,
      },
    ],
    assignments: [],
  };
}

function assignmentView(state: State, row: State['assignments'][number]) {
  const user = state.users.find((candidate) => candidate.id === row.userId);
  const zone = state.zones.find((candidate) => candidate.id === row.zoneId);
  return AssignmentSchema.parse({
    id: row.id,
    userId: row.userId,
    userEmail: user?.email ?? '',
    userDisplayName: user?.displayName ?? '',
    userIsActive: user?.isActive ?? false,
    role: row.role,
    zoneId: row.zoneId,
    zoneName: zone?.name ?? null,
    createdAt: row.createdAt,
  });
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  state: State,
  { send, sendError, readJson }: Helpers,
): Promise<void> {
  const method = req.method ?? 'GET';
  const [, resource, id, sub, subId] = segments;
  const invalid = () => sendError(res, 400, 'VALIDATION_FAILED');

  if (resource === 'users') {
    if (!id && method === 'GET')
      return send(res, 200, UserListResponseSchema.parse({ items: state.users }));
    if (!id && method === 'POST') {
      const body = CreateUserRequestSchema.safeParse(await readJson(req));
      if (!body.success) return invalid();
      if (state.users.some((user) => user.email === body.data.email)) {
        return sendError(res, 409, 'CONFLICT', { reason: 'EMAIL_TAKEN' });
      }
      const user = {
        id: randomUUID(),
        email: body.data.email,
        displayName: body.data.displayName,
        locale: body.data.locale,
        isAdmin: false,
        isActive: true,
        createdAt: NOW,
      };
      state.users.push(user);
      return send(res, 201, AdminUserSchema.parse(user));
    }
    const user = state.users.find((candidate) => candidate.id === id);
    if (!user) return sendError(res, 404, 'NOT_FOUND');
    if (method === 'POST' && (sub === 'deactivate' || sub === 'reactivate')) {
      if (user.isAdmin) return sendError(res, 403, 'FORBIDDEN');
      user.isActive = sub === 'reactivate';
      return send(res, 200, AdminUserSchema.parse(user));
    }
    return sendError(res, 404, 'NOT_FOUND');
  }

  if (resource === 'contracts') {
    return handleContracts(req, res, new URL(req.url ?? '/', 'http://mock'), segments);
  }
  if (resource !== 'projects') return sendError(res, 404, 'NOT_FOUND');
  if (!id && method === 'GET')
    return send(res, 200, ProjectListResponseSchema.parse({ items: state.projects }));
  if (!id && method === 'POST') {
    const body = CreateProjectRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    // The client and the currency are copied from the contract (ADR-027).
    const terms = contractTerms(body.data.contractId);
    if (!terms) return sendError(res, 404, 'NOT_FOUND');
    countProject(body.data.contractId);
    const project = { id: randomUUID(), ...body.data, ...terms };
    state.projects.push(project);
    return send(res, 201, ProjectSchema.parse(project));
  }
  const project = state.projects.find((candidate) => candidate.id === id);
  if (!project) return sendError(res, 404, 'NOT_FOUND');

  if (!sub && method === 'PATCH') {
    const body = UpdateProjectRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    Object.assign(project, body.data);
    return send(res, 200, ProjectSchema.parse(project));
  }
  if (sub === 'zones') {
    const zones = () =>
      state.zones
        .filter((zone) => zone.projectId === project.id)
        .map((zone) => ({ id: zone.id, name: zone.name, hasBoundary: false }));
    if (method === 'GET') return send(res, 200, ZoneListResponseSchema.parse({ items: zones() }));
    if (method === 'POST') {
      const body = CreateZoneRequestSchema.safeParse(await readJson(req));
      if (!body.success) return invalid();
      if (zones().some((zone) => zone.name.toLowerCase() === body.data.name.toLowerCase())) {
        return sendError(res, 409, 'CONFLICT', { reason: 'ZONE_NAME_TAKEN' });
      }
      const zone = { id: randomUUID(), projectId: project.id, name: body.data.name };
      state.zones.push(zone);
      return send(res, 201, ZoneSchema.parse({ id: zone.id, name: zone.name, hasBoundary: false }));
    }
  }
  if (sub === 'assignments') {
    if (method === 'GET') {
      const items = state.assignments
        .filter((row) => row.projectId === project.id)
        .map((row) => assignmentView(state, row));
      return send(res, 200, AssignmentListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const body = CreateAssignmentRequestSchema.safeParse(await readJson(req));
      if (!body.success) return invalid();
      const row = { id: randomUUID(), projectId: project.id, ...body.data, createdAt: NOW };
      state.assignments.push(row);
      return send(res, 201, assignmentView(state, row));
    }
    if (method === 'DELETE' && subId) {
      const index = state.assignments.findIndex(
        (row) => row.id === subId && row.projectId === project.id,
      );
      if (index < 0) return sendError(res, 404, 'NOT_FOUND');
      state.assignments.splice(index, 1);
      return send(res, 204);
    }
  }
  return sendError(res, 404, 'NOT_FOUND');
}
