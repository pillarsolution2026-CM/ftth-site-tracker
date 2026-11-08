import type { MessageKey } from '@ftth/i18n';
import type { ClientErrorCode } from '@/shared/api/bff-client';

const REASONS = ['VERSION_MISMATCH', 'ALREADY_DECIDED', 'TOO_MANY_POINTS'] as const;
type ProposalConflict = (typeof REASONS)[number];

function isProposalConflict(reason: string | null): reason is ProposalConflict {
  return reason !== null && (REASONS as readonly string[]).includes(reason);
}

/** A 409 with a known reason gets its own message; everything else the generic one. */
export function proposalErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (code === 'CONFLICT' && isProposalConflict(reason)) {
    return `mapping.proposals.error.${reason}`;
  }
  return `errors.${code}`;
}

/** The mapping moved on: only a reload (fresh version) lets the PM accept. */
export function proposalNeedsReload(code: ClientErrorCode, reason: string | null): boolean {
  return code === 'CONFLICT' && reason === 'VERSION_MISMATCH';
}
