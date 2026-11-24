import type { SupervisorSitesSite } from '@ftth/shared';

export interface SiteGroup {
  workOrderId: string;
  workOrderNumber: string;
  sites: SupervisorSitesSite[];
}

/** Sites grouped by work order, keeping the order the API sent. */
export function groupSitesByWorkOrder(sites: readonly SupervisorSitesSite[]): SiteGroup[] {
  const groups = new Map<string, SiteGroup>();
  for (const site of sites) {
    const group = groups.get(site.workOrderId);
    if (group) group.sites.push(site);
    else
      groups.set(site.workOrderId, {
        workOrderId: site.workOrderId,
        workOrderNumber: site.workOrderNumber,
        sites: [site],
      });
  }
  return [...groups.values()];
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
