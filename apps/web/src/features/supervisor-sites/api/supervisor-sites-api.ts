import {
  SupervisorSitesResponseSchema,
  SupervisorWithSitesSchema,
  type ReplaceSupervisorSitesRequest,
  type SupervisorSitesResponse,
  type SupervisorWithSites,
} from '@ftth/shared';
import { bffJson, projectApiPath } from '@/shared/api/bff-client';

/** GET /projects/:projectId/supervisor-sites (`supervisor_sites:manage`). */
export function getSupervisorSites(projectId: string): Promise<SupervisorSitesResponse> {
  return bffJson(projectApiPath(projectId, '/supervisor-sites'), SupervisorSitesResponseSchema);
}

/** PUT /projects/:projectId/supervisors/:userId/sites: replaces his sites in one go. */
export function replaceSupervisorSites(
  projectId: string,
  userId: string,
  body: ReplaceSupervisorSitesRequest,
): Promise<SupervisorWithSites> {
  return bffJson(
    projectApiPath(projectId, `/supervisors/${encodeURIComponent(userId)}/sites`),
    SupervisorWithSitesSchema,
    { method: 'PUT', body },
  );
}
