import { siteKeyOf, type WorkOrderSiteInput } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';

/** A site of a work order (ADR-049). Keeps its id when renamed. */
export interface WorkOrderSite {
  id: string;
  workOrderId: string;
  name: string;
  /** siteKeyOf(name): the comparison key. */
  nameKey: string;
  /** 1..n, the order of the list. */
  position: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteReplacement {
  /** The list after the change, in order. */
  sites: WorkOrderSite[];
  inserted: WorkOrderSite[];
  /** Sites whose name or position changed. */
  updated: WorkOrderSite[];
  removed: WorkOrderSite[];
}

/**
 * Plans the replacement of a work order's sites by `requested` (already validated: names unique by
 * key, ids unique). A requested id that is not a current site is refused with SITE_NOT_FOUND.
 */
export function planSiteReplacement(input: {
  workOrderId: string;
  current: readonly WorkOrderSite[];
  requested: readonly WorkOrderSiteInput[];
  actorId: string | null;
  ids: IdGenerator;
  now: Date;
}): SiteReplacement {
  const { workOrderId, current, requested, actorId, ids, now } = input;
  const byId = new Map(current.map((site) => [site.id, site]));
  const kept = new Set<string>();
  const sites: WorkOrderSite[] = [];
  const inserted: WorkOrderSite[] = [];
  const updated: WorkOrderSite[] = [];

  requested.forEach((entry, index) => {
    const position = index + 1;
    const nameKey = siteKeyOf(entry.name);
    if (nameKey === null) throw new AppError('VALIDATION_FAILED', 'A site name is empty');
    if (entry.id !== undefined) {
      const existing = byId.get(entry.id);
      if (!existing) {
        throw new AppError('CONFLICT', 'The site is not on this work order', {
          reason: 'SITE_NOT_FOUND',
          siteId: entry.id,
        });
      }
      kept.add(existing.id);
      if (existing.name === entry.name && existing.position === position) {
        sites.push(existing);
        return;
      }
      const changed = { ...existing, name: entry.name, nameKey, position, updatedAt: now };
      updated.push(changed);
      sites.push(changed);
      return;
    }
    const site: WorkOrderSite = {
      id: ids.next(),
      workOrderId,
      name: entry.name,
      nameKey,
      position,
      createdById: actorId,
      createdAt: now,
      updatedAt: now,
    };
    inserted.push(site);
    sites.push(site);
  });

  const removed = current.filter((site) => !kept.has(site.id));
  return { sites, inserted, updated, removed };
}
