import type { MessageKey } from '@ftth/i18n';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { REASON_MESSAGES } from './admin-forms';

/** Message for a failed admin call: the API's `details.reason` when known, else the error code. */
export function adminErrorKey(error: unknown): MessageKey {
  const reason = errorReasonOf(error);
  return (reason ? REASON_MESSAGES[reason] : undefined) ?? `errors.${errorCodeOf(error)}`;
}
