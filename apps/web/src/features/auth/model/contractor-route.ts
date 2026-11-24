import type { MeResponse } from '@ftth/shared';

export const CONTRACTOR_SEGMENT = 'contractor';

export const contractorHomePath = (locale: string) => `/${locale}/${CONTRACTOR_SEGMENT}`;

function isContractorPage(pathname: string, locale: string): boolean {
  const base = contractorHomePath(locale);
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Where a signed-in user must be sent, or null to stay (ADR-053). A contractor account holds no
 * project role: every page but the contractor's own goes there, and nobody else may use it.
 */
export function routeRedirect(me: MeResponse, pathname: string, locale: string): string | null {
  const onContractorPage = isContractorPage(pathname, locale);
  if (me.contractor) return onContractorPage ? null : contractorHomePath(locale);
  return onContractorPage ? `/${locale}` : null;
}
