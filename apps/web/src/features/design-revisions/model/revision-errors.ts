import { ltr, translate, type Locale, type MessageKey } from '@ftth/i18n';
import { PublishBlockedDetailsSchema, type PublishBlockedDetails } from '@ftth/shared';
import { boxTypeIssueMessage } from '@/features/box-types/model/box-types-model';
import { issueMessage } from '@/features/installation/model/installation-model';
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
    // ADR-049 part B: the General against the Secondaries of the site; the web agent writes the
    // message for the new comparison, this keeps the existing one filled meanwhile.
    const { general, secondaries } = details.cabinets;
    const names = (list: readonly string[]) => (list.length > 0 ? list.map(ltr).join('، ') : '—');
    return {
      key: 'design.publish.blocked.CABINETS_MISMATCH',
      params: {
        generalCount: ltr(general.count),
        secondaryCount: ltr(secondaries.reduce((sum, s) => sum + s.side.count, 0)),
        onlyGeneral: names(details.cabinets.missingInSecondaries),
        onlySecondary: names([
          ...details.cabinets.missingInGeneral,
          ...details.cabinets.inSeveralSecondaries,
        ]),
        unnamed: ltr(general.unnamed + secondaries.reduce((sum, s) => sum + s.side.unnamed, 0)),
      },
    };
  }
  if (details.reason === 'CABINET_IN_OTHER_SITE') {
    // New refusal (ADR-049 part B): no message of its own yet; the cabinets of the other site are named.
    return {
      key: 'design.publish.blocked.CABINETS_MISMATCH',
      params: {
        generalCount: ltr(details.cabinets.length),
        secondaryCount: ltr(0),
        onlyGeneral: details.cabinets.map((c) => ltr(c.name)).join('، '),
        onlySecondary: '—',
        unnamed: ltr(0),
      },
    };
  }
  if (details.reason === 'SITE_INCOMPLETE') {
    return {
      key: 'design.publish.blocked.OTHER_DRAWING_MISSING',
      params: {
        drawing: details.missingKinds.map((k) => translate(locale, `drawingKind.${k}`)).join('، '),
      },
    };
  }
  const drawing = translate(locale, `drawingKind.${details.drawingKind}`);
  if (details.reason === 'INSTALLATION_UNCLEAR') {
    const issues = details.issues
      .map((issue) => {
        const message = issueMessage(issue);
        return translate(locale, message.key, message.params);
      })
      .join(' ');
    return {
      key: 'design.publish.blocked.INSTALLATION_UNCLEAR',
      params: { drawing, count: ltr(details.issueCount), issues },
    };
  }
  if (details.reason === 'BOX_TYPES_UNCLEAR') {
    const issues = details.issues
      .map((issue) => {
        const message = boxTypeIssueMessage(issue);
        return translate(locale, message.key, message.params);
      })
      .join(' ');
    return {
      key: 'design.publish.blocked.BOX_TYPES_UNCLEAR',
      params: { drawing, count: ltr(details.issueCount), issues },
    };
  }
  switch (details.reason) {
    case 'SITE_UNASSIGNED':
    case 'DRAWING_NOT_READY':
      // ADR-049 part B: until their own messages exist, these say the drawing is not ready.
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
