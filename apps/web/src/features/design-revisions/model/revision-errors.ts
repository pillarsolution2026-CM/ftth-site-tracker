import { ltr, translate, type Locale, type MessageKey } from '@ftth/i18n';
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

/**
 * The clear message for each 409 refusal reason of publish (ADR-038, ADR-040). `drawing` names the
 * drawing that blocks («الجينيرال (رئيسي)» / «الثانوي»).
 */
export function publishBlockedMessage(
  details: PublishBlockedDetails,
  locale: Locale,
): ErrorMessage {
  if (details.reason === 'OPEN_ITEMS') {
    return { key: 'design.publish.blocked.OPEN_ITEMS', params: {} };
  }
  if (details.reason === 'CABINETS_MISMATCH') {
    const { general, secondary } = details.cabinets;
    const names = (list: readonly string[]) => (list.length > 0 ? list.map(ltr).join('، ') : '—');
    return {
      key: 'design.publish.blocked.CABINETS_MISMATCH',
      params: {
        generalCount: ltr(general.count),
        secondaryCount: ltr(secondary.count),
        onlyGeneral: names(general.missingInOther),
        onlySecondary: names(secondary.missingInOther),
        unnamed: ltr(general.unnamed + secondary.unnamed),
      },
    };
  }
  const drawing = translate(locale, `drawingKind.${details.drawingKind}`);
  switch (details.reason) {
    case 'OTHER_DRAWING_MISSING':
      return { key: 'design.publish.blocked.OTHER_DRAWING_MISSING', params: { drawing } };
    case 'CRS_UNKNOWN':
      return { key: 'design.publish.blocked.CRS_UNKNOWN', params: { drawing } };
    case 'PLACEMENT_MISSING':
      return { key: 'design.publish.blocked.PLACEMENT_MISSING', params: { drawing } };
    case 'PROBLEMS_OPEN':
      return {
        key: 'design.publish.blocked.PROBLEMS_OPEN',
        params: { drawing, count: ltr(details.problemCount) },
      };
  }
}
