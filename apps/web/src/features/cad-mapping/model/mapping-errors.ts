import type { MessageKey } from '@ftth/i18n';
import type { ClientErrorCode } from '@/shared/api/bff-client';

const CONFLICT_REASONS = [
  'VERSION_MISMATCH',
  'NOT_PROCESSED',
  'NO_MAPPING',
  'MAPPING_VERSION_MISMATCH',
  'REVISION_IN_PROGRESS',
  'NOT_CURRENT_VERSION',
] as const;
type ConflictReason = (typeof CONFLICT_REASONS)[number];

function isConflictReason(reason: string | null): reason is ConflictReason {
  return reason !== null && (CONFLICT_REASONS as readonly string[]).includes(reason);
}

/** 422 on save: a text role or zone layer that the file's drawing kind does not read (ADR-041). */
const KIND_REASONS = ['ROLE_NOT_FOR_KIND', 'ZONE_NOT_FOR_KIND'] as const;
type KindReason = (typeof KIND_REASONS)[number];

function isKindReason(reason: string | null): reason is KindReason {
  return reason !== null && (KIND_REASONS as readonly string[]).includes(reason);
}

/** A 409/422 with a known reason gets its own message; everything else the generic one. */
export function mappingErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (code === 'CONFLICT' && isConflictReason(reason)) return `mapping.error.${reason}`;
  if (code === 'VALIDATION_FAILED' && isKindReason(reason)) return `mapping.error.${reason}`;
  return `errors.${code}`;
}

/** The saved mapping moved on (or the revision would use an older one): offer a reload. */
export function needsReload(code: ClientErrorCode, reason: string | null): boolean {
  return (
    code === 'CONFLICT' && (reason === 'VERSION_MISMATCH' || reason === 'MAPPING_VERSION_MISMATCH')
  );
}
