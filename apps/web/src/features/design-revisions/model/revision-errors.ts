import { ltr, type MessageKey } from '@ftth/i18n';
import { PublishBlockedDetailsSchema, type PublishBlockedDetails } from '@ftth/shared';
import { ApiClientError, type ClientErrorCode } from '@/shared/api/bff-client';

const REASONS = [
  'NOT_DRAFT',
  'NOT_DISCARDABLE',
  'REVISION_LOCKED',
  'FEATURE_TYPE_NOT_ALLOWED',
  'FEATURE_REQUIRED',
] as const;
type Reason = (typeof REASONS)[number];

/** 409/422 with a known reason gets its own message; everything else the generic one. */
export function revisionErrorKey(code: ClientErrorCode, reason: string | null): MessageKey {
  if (
    (code === 'CONFLICT' || code === 'VALIDATION_FAILED') &&
    reason !== null &&
    (REASONS as readonly string[]).includes(reason)
  ) {
    return `design.error.${reason as Reason}`;
  }
  return `errors.${code}`;
}

/** The 409 refusal reason of publish with its details, or null for any other error. */
export function publishBlockedOf(error: unknown): PublishBlockedDetails | null {
  if (!(error instanceof ApiClientError) || error.code !== 'CONFLICT') return null;
  const parsed = PublishBlockedDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

export interface ErrorMessage {
  key: MessageKey;
  params: Record<string, string | number>;
}

/** The clear message for each 409 refusal reason of publish (ADR-038). */
export function publishBlockedMessage(details: PublishBlockedDetails): ErrorMessage {
  switch (details.reason) {
    case 'CRS_UNKNOWN':
      return { key: 'design.publish.blocked.CRS_UNKNOWN', params: {} };
    case 'PLACEMENT_MISSING':
      return { key: 'design.publish.blocked.PLACEMENT_MISSING', params: {} };
    case 'PROBLEMS_OPEN':
      return {
        key: 'design.publish.blocked.PROBLEMS_OPEN',
        params: { count: ltr(details.problemCount) },
      };
    case 'OPEN_ITEMS':
      return { key: 'design.publish.blocked.OPEN_ITEMS', params: {} };
  }
}
