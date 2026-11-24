import { z } from 'zod';

/**
 * Supervisors work by SITE (ADR-054, owner 2026-11-21, point 2-ج "zones"):
 * - Each supervisor holds one or more sites of the work order (ADR-049 sites); a site may have
 *   several supervisors. Name-only zones are retired.
 * - A supervisor sees and records only on his sites: the phone shows only their names and
 *   drawings. Without a site he sees nothing (fail closed). PM and QC stay project-wide.
 * - The ADMIN and the PM (within his project) give supervisors their sites; accounts and the
 *   supervisor's assignment to the project stay with the admin.
 * - Taking a site away: unsent updates on it are rejected at sync (`FEATURE_OUT_OF_SCOPE`).
 */

export const SupervisorSitesSiteSchema = z.object({
  siteId: z.uuid(),
  name: z.string(),
  workOrderId: z.uuid(),
  workOrderNumber: z.string(),
});
export type SupervisorSitesSite = z.infer<typeof SupervisorSitesSiteSchema>;

export const SupervisorWithSitesSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  /** In the order of `sites`. */
  siteIds: z.array(z.uuid()),
});
export type SupervisorWithSites = z.infer<typeof SupervisorWithSitesSchema>;

/**
 * GET /projects/:projectId/supervisor-sites (`supervisor_sites:manage`: admin, pm): every site
 * of the project's work orders (work-order then site position order) and every supervisor
 * assigned to the project with his sites.
 */
export const SupervisorSitesResponseSchema = z.object({
  sites: z.array(SupervisorSitesSiteSchema),
  supervisors: z.array(SupervisorWithSitesSchema),
});
export type SupervisorSitesResponse = z.infer<typeof SupervisorSitesResponseSchema>;

/**
 * PUT /projects/:projectId/supervisors/:userId/sites (`supervisor_sites:manage`) → the
 * supervisor. Replaces his sites in one go (empty = none). 404 when the user is not a supervisor
 * assigned to the project; 422 VALIDATION when a site is not a site of this project.
 */
export const ReplaceSupervisorSitesRequestSchema = z.strictObject({
  siteIds: z
    .array(z.uuid())
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Repeated site'),
});
export type ReplaceSupervisorSitesRequest = z.infer<typeof ReplaceSupervisorSitesRequestSchema>;

/** `events.type` of a change (entity `supervisor_sites`, entity id = the user id). */
export const SUPERVISOR_SITES_EVENT = 'supervisor.sites_changed';
