import { UPDATE_STATUSES, type PortalLine, type PortalWork, type UpdateStatus } from '@ftth/shared';
import type { PortalRegistration } from '@ftth/shared';

export type RegistrationFilter = 'all' | string;
export type StatusFilter = 'all' | UpdateStatus;

export interface PortalFilters {
  registrationId: RegistrationFilter;
  status: StatusFilter;
}

export const NO_FILTERS: PortalFilters = { registrationId: 'all', status: 'all' };

export const STATUS_OPTIONS: readonly UpdateStatus[] = UPDATE_STATUSES;

/** The work list under the filters; the server's newest-first order is kept. */
export function filterWork(work: readonly PortalWork[], filters: PortalFilters): PortalWork[] {
  return work.filter(
    (entry) =>
      (filters.registrationId === 'all' || entry.registrationId === filters.registrationId) &&
      (filters.status === 'all' || entry.status === filters.status),
  );
}

export function isStatusFilter(value: string): value is StatusFilter {
  return value === 'all' || (STATUS_OPTIONS as readonly string[]).includes(value);
}

/** Registration and line of a work entry, for the table's registration / line columns. */
export function indexRegistrations(registrations: readonly PortalRegistration[]) {
  const byRegistration = new Map<string, PortalRegistration>();
  const lineById = new Map<string, PortalLine>();
  for (const registration of registrations) {
    byRegistration.set(registration.registrationId, registration);
    for (const line of registration.lines) lineById.set(line.contractorLineId, line);
  }
  return { byRegistration, lineById };
}
